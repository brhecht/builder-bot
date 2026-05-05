import { NextRequest, NextResponse } from 'next/server'
import { DateTime } from 'luxon'
import {
  getLastReported,
  setLastReported,
  getPendingIntros,
  setPendingIntros,
  clearPendingIntros,
} from '@/lib/kv'
import {
  getChannelMessages,
  getThreadReplies,
  getUserName,
  postMessage,
  makeDeepLink,
} from '@/lib/slack'
import { scoreAndSummarize, processIntro } from '@/lib/claude'
import { fetchUrlContent, extractFirstUrl } from '@/lib/url-fetch'
import { ConversationCandidate, IntroCandidate, PendingIntro, SlackMessage } from '@/lib/types'

// maxDuration for App Router route handlers
export const maxDuration = 60

const CHANNELS = {
  INTRODUCE_YOURSELF: process.env.SLACK_CHANNEL_INTRODUCE_YOURSELF!,
  SHARE_AND_DISCUSS: process.env.SLACK_CHANNEL_SHARE_AND_DISCUSS!,
  WHAT_IM_BUILDING: process.env.SLACK_CHANNEL_WHAT_IM_BUILDING!,
  GENERAL: process.env.SLACK_CHANNEL_GENERAL!,
  DAILY_RECAP: process.env.SLACK_DAILY_RECAP_CHANNEL_ID ?? 'C0AUS1Q7917',
}

const CHANNEL_NAMES: Record<string, string> = {
  [process.env.SLACK_CHANNEL_SHARE_AND_DISCUSS ?? '']: 'share-and-discuss',
  [process.env.SLACK_CHANNEL_WHAT_IM_BUILDING ?? '']: 'what-im-building',
  [process.env.SLACK_CHANNEL_GENERAL ?? '']: 'general',
}

function log(msg: string) {
  console.log(`[builder-bot] ${msg}`)
}

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // DST-aware time check: run only if it's 9:00–10:59 AM New York time
  // Single cron at 14:30 UTC fires at 9:30 AM EST (winter) and 10:30 AM EDT (summer)
  // ?test=true bypasses time/day gate (requires valid CRON_SECRET)
  // ?channel=<id> (test only) overrides post target — useful to DM yourself a preview
  // ?lookback_hours=<N> (test only) overrides KV timestamps with now-N*3600 — useful to backfill
  const isTest = req.nextUrl.searchParams.get('test') === 'true'
  const isDryRun = req.nextUrl.searchParams.get('dry_run') === 'true'
  const channelOverride = isTest ? req.nextUrl.searchParams.get('channel') : null
  const lookbackHoursParam = isTest ? req.nextUrl.searchParams.get('lookback_hours') : null
  const lookbackHours = lookbackHoursParam ? parseFloat(lookbackHoursParam) : null
  const now = DateTime.now().setZone('America/New_York')
  if (!isTest) {
    if (now.weekday > 5) {
      log('Skipping — weekend')
      return NextResponse.json({ skipped: 'weekend' })
    }
    if (now.hour < 9 || now.hour >= 11) {
      log(`Skipping — outside 9–11 AM NYC window (current: ${now.toFormat('HH:mm z')})`)
      return NextResponse.json({ skipped: 'outside-window' })
    }
  } else {
    log(`Test mode — bypassing time/day gate (${now.toFormat('cccc HH:mm z')})`)
  }

  log(`Starting run — ${now.toFormat('cccc, LLLL d, HH:mm z')}`)

  // 1. Read KV state
  const convChannels = [CHANNELS.SHARE_AND_DISCUSS, CHANNELS.WHAT_IM_BUILDING, CHANNELS.GENERAL]
  const allChannels = [CHANNELS.INTRODUCE_YOURSELF, ...convChannels]

  const [pendingIntros, ...lastTimestamps] = await Promise.all([
    getPendingIntros(),
    ...allChannels.map((ch) => getLastReported(ch)),
  ])

  const lastReported: Record<string, number> = {}
  allChannels.forEach((ch, i) => { lastReported[ch] = lastTimestamps[i] })

  // Test-only override: force a wider lookback window
  if (lookbackHours && lookbackHours > 0) {
    const overrideTs = Math.floor(Date.now() / 1000) - lookbackHours * 3600
    for (const ch of allChannels) lastReported[ch] = overrideTs
    log(`Test mode — lookback overridden to ${lookbackHours}h ago`)
  }

  // 2. Fetch messages from all channels concurrently
  const [introResult, ...convResults] = await Promise.allSettled([
    getChannelMessages(CHANNELS.INTRODUCE_YOURSELF, lastReported[CHANNELS.INTRODUCE_YOURSELF]),
    ...convChannels.map((ch) => getChannelMessages(ch, lastReported[ch])),
  ])

  // 3. Extract intro candidates
  const todayIntros: IntroCandidate[] = []
  if (introResult.status === 'fulfilled') {
    for (const msg of introResult.value) {
      // Substantial messages in #introduce-yourself are intro posts
      if (msg.text && msg.text.length > 80) {
        todayIntros.push({ ts: msg.ts, raw_text: msg.text })
      }
    }
  } else {
    log(`#introduce-yourself unavailable: ${introResult.reason}`)
  }

  // 4. Build conversation candidates with URL dedup
  const urlMap = new Map<string, { candidate: ConversationCandidate; score: number }>()
  const noUrlCandidates: ConversationCandidate[] = []

  for (let i = 0; i < convChannels.length; i++) {
    const channelId = convChannels[i]
    const result = convResults[i]

    if (result.status === 'rejected') {
      const err = result.reason instanceof Error ? result.reason.message : String(result.reason)
      log(`Skipping ${CHANNEL_NAMES[channelId]}: ${err}`)
      continue
    }

    for (const msg of result.value) {
      if (!msg.text || msg.text.trim().length < 30) continue

      const replies = msg.reply_count && msg.reply_count > 0
        ? await getThreadReplies(channelId, msg.ts)
        : []

      const userDisplay = await getUserName(msg.user ?? msg.username ?? 'unknown')

      const url = extractFirstUrl(msg.text)
        ?? extractFirstUrl(msg.attachments?.map((a) => a.from_url ?? a.title_link ?? '').join(' ') ?? '')

      let urlContent: string | undefined
      if (url) {
        const fetched = await fetchUrlContent(url, msg.attachments?.[0])
        urlContent = fetched.text || undefined
      }

      const candidate: ConversationCandidate = {
        channel_id: channelId,
        channel_name: CHANNEL_NAMES[channelId] ?? channelId,
        ts: msg.ts,
        user_name: userDisplay,
        text: msg.text,
        replies,
        reply_count: msg.reply_count ?? 0,
        url,
        url_content: urlContent,
      }

      if (url) {
        // Keep only the most substantive thread per URL
        const score = replies.length * 5 + msg.text.length
        const existing = urlMap.get(url)
        if (!existing || score > existing.score) {
          urlMap.set(url, { candidate, score })
        }
      } else {
        noUrlCandidates.push(candidate)
      }
    }
  }

  const allCandidates: ConversationCandidate[] = [
    ...noUrlCandidates,
    ...Array.from(urlMap.values()).map((e) => e.candidate),
  ]

  const channelDiag: Record<string, number | string> = {}
  for (let i = 0; i < convChannels.length; i++) {
    const r = convResults[i]
    const name = CHANNEL_NAMES[convChannels[i]] ?? convChannels[i]
    channelDiag[name] = r.status === 'fulfilled'
      ? r.value.length
      : (r.reason instanceof Error ? r.reason.message : String(r.reason))
  }
  channelDiag['introduce-yourself'] = introResult.status === 'fulfilled'
    ? introResult.value.length
    : (introResult.reason instanceof Error ? introResult.reason.message : String(introResult.reason))

  log(`${allCandidates.length} conversation candidates before Claude scoring`)

  // 5. Claude scoring
  const scored = await scoreAndSummarize(allCandidates)

  // Enforce max 2 per channel, max 3 total
  const channelCounts: Record<string, number> = {}
  const included = scored
    .filter((s) => s.decision === 'Include')
    .filter((s) => {
      const ch = s.candidate.channel_id
      channelCounts[ch] = (channelCounts[ch] ?? 0) + 1
      return channelCounts[ch] <= 2
    })
    .slice(0, 3)

  log(`${included.length} items after Claude curation`)

  const nowTs = Math.floor(Date.now() / 1000)
  const todayStr = now.toISODate()!

  const updateTimestamps = () =>
    Promise.all(allChannels.map((ch) => setLastReported(ch, nowTs)))

  // 6. Skip logic
  if (included.length < 2) {
    log('Skipping post — fewer than 2 qualifying items')

    // Carry forward any new intros
    const freshIntros = await Promise.all(
      todayIntros.map((i) => processIntro(i, todayStr).catch(() => null))
    )
    const validIntros = freshIntros.filter((i): i is PendingIntro => i !== null)

    await Promise.all([
      setPendingIntros([...pendingIntros, ...validIntros]),
      updateTimestamps(),
    ])

    return NextResponse.json({
      status: 'skipped',
      reason: 'below-threshold',
      items: included.length,
      intros_carried: validIntros.length,
      ...(isTest && {
        _diag: {
          channels: channelDiag,
          candidates_total: allCandidates.length,
          intro_candidates: todayIntros.length,
          scored_include: scored.filter((s) => s.decision === 'Include').length,
          scored_skip: scored.filter((s) => s.decision === 'Skip').length,
        },
      }),
    })
  }

  // 7. Process intros for today + carry forward
  const freshIntros = await Promise.all(
    todayIntros.map((i) => processIntro(i, todayStr).catch(() => null))
  )
  const allIntros: PendingIntro[] = [
    ...pendingIntros,
    ...freshIntros.filter((i): i is PendingIntro => i !== null),
  ]

  // 8. Build the post
  const dateStr = now.toFormat('cccc, LLLL d') // e.g. "Wednesday, April 23"
  const lines: string[] = [`*Top Builder Conversations — ${dateStr}*`]

  if (allIntros.length > 0) {
    lines.push('\n👋 *New to the community*')
    for (const intro of allIntros) {
      lines.push(`• *${intro.name}* — ${intro.summary}`)
    }
  }

  lines.push('\n💬 *Top Builder Conversations*')
  for (const item of included) {
    const link = makeDeepLink(item.candidate.channel_id, item.candidate.ts)
    lines.push(`• *${item.candidate.user_name}* (#${item.candidate.channel_name}) — ${item.summary} ${link}`)
  }

  const post = lines.join('\n')

  // 9. Post to Slack (skip if dry run)
  if (isDryRun) {
    log('Dry run — skipping Slack post')
    return NextResponse.json({
      status: 'dry_run',
      items: included.length,
      intros: allIntros.length,
      date: dateStr,
      preview: post,
    })
  }

  const targetChannel = channelOverride ?? CHANNELS.DAILY_RECAP
  log(`Posting to ${targetChannel}${channelOverride ? ' (test override)' : ' (#daily-recap-bot)'}`)
  await postMessage(targetChannel, post)
  log('Posted successfully')

  // 10. Update KV state — only on a real post (not when overriding the target channel)
  // Test posts to a different channel must NOT advance the production state
  if (!channelOverride) {
    try {
      await Promise.all([clearPendingIntros(), updateTimestamps()])
    } catch (err) {
      log(`KV update failed after post (non-fatal): ${err}`)
    }
  } else {
    log('Test override — skipping KV state update')
  }

  return NextResponse.json({
    status: 'posted',
    items: included.length,
    intros: allIntros.length,
    date: dateStr,
    target: targetChannel,
    test_override: !!channelOverride,
  })
}
