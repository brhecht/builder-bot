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
import { generateRecap } from '@/lib/claude'
import { fetchUrlContent, extractFirstUrl } from '@/lib/url-fetch'
import { ConversationCandidate, IntroCandidate, PendingIntro } from '@/lib/types'

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
  [process.env.SLACK_CHANNEL_INTRODUCE_YOURSELF ?? '']: 'introductions',
}

// DM-mode targets: Brian + Nico for now (testing). Comma-separated user/channel
// IDs in SLACK_DM_TARGETS override the public #daily-recap-bot channel.
function getRecapTargets(): string[] {
  const dmTargets = (process.env.SLACK_DM_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (dmTargets.length > 0) return dmTargets
  return [CHANNELS.DAILY_RECAP]
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

  // 3. Build intro candidates with author + permalink. v2 prompt enforces the
  // self-intro filter (drops welcomes / third-party intros) so we pass author
  // metadata through; we still pre-trim very short messages to save tokens.
  const introCandidates: IntroCandidate[] = []
  if (introResult.status === 'fulfilled') {
    for (const msg of introResult.value) {
      if (!msg.text || msg.text.length < 80) continue
      const userId = msg.user ?? msg.username ?? 'unknown'
      const userName = await getUserName(userId)
      introCandidates.push({
        ts: msg.ts,
        raw_text: msg.text,
        user_id: userId,
        user_name: userName,
        permalink: makeDeepLink(CHANNELS.INTRODUCE_YOURSELF, msg.ts),
      })
    }
  } else {
    log(`#introduce-yourself unavailable: ${introResult.reason}`)
  }

  // 4. Build conversation candidates with URL dedup + replier display names
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
        permalink: makeDeepLink(channelId, msg.ts),
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
  channelDiag['introductions'] = introResult.status === 'fulfilled'
    ? introResult.value.length
    : (introResult.reason instanceof Error ? introResult.reason.message : String(introResult.reason))

  log(`${allCandidates.length} conversation candidates, ${introCandidates.length} intro candidates`)

  const nowTs = Math.floor(Date.now() / 1000)
  const todayStr = now.toISODate()!
  const dateStr = now.toFormat('ccc LLL d') // e.g. "Tue May 5" — matches v2 prompt sample

  const updateTimestamps = () =>
    Promise.all(allChannels.map((ch) => setLastReported(ch, nowTs)))

  // 5. Carry forward intros that pre-date today (kept as PendingIntro for the
  //    legacy KV format). We surface their raw text + permalink to the LLM.
  const carriedIntroCandidates: IntroCandidate[] = pendingIntros
    .filter((p): p is PendingIntro => !!p && !!p.summary)
    .map((p) => ({
      ts: '',
      raw_text: p.summary, // legacy summary; LLM will treat as message body
      user_id: '',
      user_name: p.name ?? '',
      permalink: p.permalink ?? '',
    }))

  const allIntros: IntroCandidate[] = [...carriedIntroCandidates, ...introCandidates]

  // 6. Generate the recap in one pass
  const post = await generateRecap({
    dateStr,
    conversations: allCandidates,
    intros: allIntros,
  })

  // 7. Skip logic — generator returns null when nothing qualifies
  if (!post) {
    log('Skipping post — generator returned no recap (empty day or below threshold)')

    // Carry forward today's intros so they appear in the next post
    const newPending: PendingIntro[] = introCandidates.map((i) => ({
      name: i.user_name,
      summary: i.raw_text.slice(0, 500),
      collected_date: todayStr,
      permalink: i.permalink,
    }))

    await Promise.all([
      setPendingIntros([...pendingIntros, ...newPending]),
      updateTimestamps(),
    ])

    return NextResponse.json({
      status: 'skipped',
      reason: 'below-threshold',
      candidates: allCandidates.length,
      intros: allIntros.length,
      intros_carried: newPending.length,
      ...(isTest && {
        _diag: {
          channels: channelDiag,
        },
      }),
    })
  }

  // 8. Post to Slack (skip if dry run)
  if (isDryRun) {
    log('Dry run — skipping Slack post')
    return NextResponse.json({
      status: 'dry_run',
      candidates: allCandidates.length,
      intros: allIntros.length,
      date: dateStr,
      preview: post,
      // Diagnostic: list each candidate so we can verify what the LLM
      // received and which intros it dropped (welcomes vs. self-intros).
      _intros_in: allIntros.map((i) => ({
        author: i.user_name,
        first_120: i.raw_text.slice(0, 120),
      })),
      _convos_in: allCandidates.map((c) => ({
        author: c.user_name,
        channel: c.channel_name,
        replies: c.reply_count,
        first_120: c.text.slice(0, 120),
      })),
    })
  }

  const targets = channelOverride ? [channelOverride] : getRecapTargets()
  log(`Posting to ${targets.length} target(s): ${targets.join(', ')}${channelOverride ? ' (test override)' : ''}`)

  const postResults = await Promise.allSettled(targets.map((t) => postMessage(t, post)))
  const failed = postResults
    .map((r, i) => (r.status === 'rejected' ? { target: targets[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) } : null))
    .filter((x): x is { target: string; error: string } => x !== null)
  if (failed.length > 0) log(`Post failures: ${JSON.stringify(failed)}`)
  log(`Posted to ${targets.length - failed.length}/${targets.length} target(s)`)

  // 9. Update KV state — only on a real (non-overridden) post
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
    candidates: allCandidates.length,
    intros: allIntros.length,
    date: dateStr,
    targets,
    failed,
    test_override: !!channelOverride,
  })
}
