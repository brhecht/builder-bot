import { NextRequest, NextResponse } from 'next/server'
import { DateTime } from 'luxon'
import {
  getLastReported,
  setLastReported,
  getPendingIntros,
  setPendingIntros,
  clearPendingIntros,
  getLastPostedKeys,
  setLastPostedKeys,
} from '@/lib/kv'
import {
  getChannelMessages,
  getThreadReplies,
  getUserName,
  postMessage,
  makeDeepLink,
  isBotAuthored,
} from '@/lib/slack'
import { generateRecap, lastLLMOutput } from '@/lib/claude'
import { fetchUrlContent, extractFirstUrl } from '@/lib/url-fetch'
import { ConversationCandidate, IntroCandidate, PendingIntro } from '@/lib/types'

// maxDuration for App Router route handlers
export const maxDuration = 60

// The recap covers whole days that have already ended. If a run is missed the
// next one carries the gap, but never more than this many days — a long outage
// should not dump a week into one post.
const MAX_CATCHUP_DAYS = 3

// The bar for calling a thread "top". A post with nothing on it yet is not a
// top conversation, which is how a post made that same morning ended up in the
// recap (Chuck, Aug 21). Either condition qualifies. Env-tunable so the floor
// can move without a deploy.
const MIN_REPLIES_FOR_TOP = Number(process.env.BB_MIN_REPLIES ?? 1)
const MIN_REACTIONS_FOR_TOP = Number(process.env.BB_MIN_REACTIONS ?? 2)

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

  // Time check: run only if it's 8:00–8:59 AM Bogotá time (Colombia has no DST)
  // Single cron at 13:00 UTC fires at 8:00 AM COT year-round, every day
  // ?test=true bypasses time/day gate (requires valid CRON_SECRET)
  // ?channel=<id> (test only) overrides post target — useful to DM yourself a preview
  // ?lookback_hours=<N> (test only) overrides KV timestamps with now-N*3600 — useful to backfill
  const isTest = req.nextUrl.searchParams.get('test') === 'true'
  const isDryRun = req.nextUrl.searchParams.get('dry_run') === 'true'
  const channelOverride = isTest ? req.nextUrl.searchParams.get('channel') : null
  const lookbackHoursParam = isTest ? req.nextUrl.searchParams.get('lookback_hours') : null
  const lookbackHours = lookbackHoursParam ? parseFloat(lookbackHoursParam) : null
  const now = DateTime.now().setZone('America/Bogota')
  if (!isTest) {
    // Luxon: weekday 1=Mon … 7=Sun. Brian (May 13 PM) wants the recap every day
    // EXCEPT Sundays — keep Sunday quiet so Monday's post lands fresh.
    if (now.weekday === 7) {
      log('Skipping — Sunday')
      return NextResponse.json({ skipped: 'sunday' })
    }
    if (now.hour < 8 || now.hour >= 9) {
      log(`Skipping — outside 8–9 AM Bogotá window (current: ${now.toFormat('HH:mm z')})`)
      return NextResponse.json({ skipped: 'outside-window' })
    }
  } else {
    log(`Test mode — bypassing time/day gate (${now.toFormat('cccc HH:mm z')})`)
  }

  log(`Starting run — ${now.toFormat('cccc, LLLL d, HH:mm z')}`)

  // 1. Read KV state
  const convChannels = [CHANNELS.SHARE_AND_DISCUSS, CHANNELS.WHAT_IM_BUILDING, CHANNELS.GENERAL]
  const allChannels = [CHANNELS.INTRODUCE_YOURSELF, ...convChannels]

  const [pendingIntros, lastPostedKeys, ...lastTimestamps] = await Promise.all([
    getPendingIntros(),
    getLastPostedKeys(),
    ...allChannels.map((ch) => getLastReported(ch)),
  ])

  // Build a Set of permalinks + URLs that appeared in yesterday's recap so we
  // can drop today's duplicates before they reach the LLM. Same thread or same
  // shared link shouldn't be surfaced twice in a row.
  const dedupSet = new Set(lastPostedKeys.filter(Boolean))

  const lastReported: Record<string, number> = {}
  allChannels.forEach((ch, i) => { lastReported[ch] = lastTimestamps[i] })

  // 1b. Window: whole days that have already ended, right edge at today 00:00.
  // Slack now gets an explicit `latest`, so the 9 AM run can no longer pick up a
  // post made at 8:55 that same morning. The left edge is wherever the last run
  // stopped, so Monday still carries Saturday and Sunday rather than dropping
  // them, capped at MAX_CATCHUP_DAYS.
  const windowEndDt = now.startOf('day')
  const dayStartDt = windowEndDt.minus({ days: 1 })
  const catchupFloorDt = windowEndDt.minus({ days: MAX_CATCHUP_DAYS })
  const windowEnd = Math.floor(windowEndDt.toSeconds())
  const dayStart = Math.floor(dayStartDt.toSeconds())
  const catchupFloor = Math.floor(catchupFloorDt.toSeconds())

  const windowStart: Record<string, number> = {}
  for (const ch of allChannels) {
    windowStart[ch] = Math.max(catchupFloor, Math.min(lastReported[ch], dayStart))
  }

  // Test-only override: force a wider lookback and open the right edge
  let latestArg: number | undefined = windowEnd
  if (lookbackHours && lookbackHours > 0) {
    const overrideTs = Math.floor(Date.now() / 1000) - lookbackHours * 3600
    for (const ch of allChannels) windowStart[ch] = overrideTs
    latestArg = undefined
    log(`Test mode — lookback overridden to ${lookbackHours}h ago, right edge open`)
  }

  // 2. Fetch messages from all channels concurrently
  const [introResult, ...convResults] = await Promise.allSettled([
    getChannelMessages(CHANNELS.INTRODUCE_YOURSELF, windowStart[CHANNELS.INTRODUCE_YOURSELF], latestArg),
    ...convChannels.map((ch) => getChannelMessages(ch, windowStart[ch], latestArg)),
  ])

  // 3. Build intro candidates with author + permalink. v2 prompt enforces the
  // self-intro filter (drops welcomes / third-party intros) so we pass author
  // metadata through; we still pre-trim very short messages to save tokens.
  //
  // Also fetch thread replies under each top-level message — when a founder
  // posts "Friends, please welcome @X" and X self-introduces in the thread,
  // X's reply IS the self-intro. Treating it as a top-level intro candidate
  // lets the prompt's existing self-intro filter (author == person being
  // introduced) surface it correctly. Without this, welcomed-then-replied
  // members were getting dropped silently (Brian feedback May 11).
  const introCandidates: IntroCandidate[] = []
  const introSeen = new Set<string>() // dedup key: `${user_id}:${ts}`
  if (introResult.status === 'fulfilled') {
    for (const msg of introResult.value) {
      if (isBotAuthored(msg)) continue
      if (msg.text && msg.text.length >= 80) {
        const userId = msg.user ?? msg.username ?? 'unknown'
        const userName = await getUserName(userId)
        const key = `${userId}:${msg.ts}`
        if (!introSeen.has(key)) {
          introSeen.add(key)
          introCandidates.push({
            ts: msg.ts,
            raw_text: msg.text,
            user_id: userId,
            user_name: userName,
            permalink: makeDeepLink(CHANNELS.INTRODUCE_YOURSELF, msg.ts),
          })
        }

        // Welcome surfacing: when a message mentions another user via
        // <@USERID> in the first 200 chars and is substantive, also emit a
        // candidate keyed by the welcomed person. The LLM's self-intro
        // filter sees author == subject of the welcome and surfaces them
        // even if they haven't self-introduced yet (Brian feedback May 11:
        // welcomes should let new members appear in the recap immediately).
        const mentionMatch = msg.text.slice(0, 200).match(/<@([A-Z0-9]+)>/)
        if (mentionMatch && mentionMatch[1] !== userId) {
          const mentionedId = mentionMatch[1]
          const mentionedName = await getUserName(mentionedId)
          const mKey = `${mentionedId}:${msg.ts}`
          if (!introSeen.has(mKey)) {
            introSeen.add(mKey)
            introCandidates.push({
              ts: msg.ts,
              raw_text: msg.text,
              user_id: mentionedId,
              user_name: mentionedName,
              permalink: makeDeepLink(CHANNELS.INTRODUCE_YOURSELF, msg.ts),
            })
          }
        }
      }

      // Thread replies inside #introduce-yourself: each reply ≥80 chars becomes
      // its own intro candidate keyed by the replier's name. The LLM's
      // self-intro filter then keeps replies whose author == the person being
      // welcomed and drops congratulatory replies from existing members.
      if (msg.reply_count && msg.reply_count > 0) {
        const threadReplies = await getThreadReplies(CHANNELS.INTRODUCE_YOURSELF, msg.ts)
        for (const reply of threadReplies) {
          if (!reply.text || reply.text.length < 80) continue
          const replierId = reply.user ?? reply.username ?? 'unknown'
          const replierName = reply.user_name && !reply.user_name.toLowerCase().includes('unresolved')
            ? reply.user_name
            : await getUserName(replierId)
          const key = `${replierId}:${reply.ts}`
          if (!introSeen.has(key)) {
            introSeen.add(key)
            introCandidates.push({
              ts: reply.ts,
              raw_text: reply.text,
              user_id: replierId,
              user_name: replierName,
              permalink: makeDeepLink(CHANNELS.INTRODUCE_YOURSELF, reply.ts),
            })
          }
        }
      }
    }
  } else {
    log(`#introduce-yourself unavailable: ${introResult.reason}`)
  }

  // 4. Build conversation candidates with URL dedup + replier display names
  const urlMap = new Map<string, { candidate: ConversationCandidate; score: number }>()
  const noUrlCandidates: ConversationCandidate[] = []
  let droppedBotAuthored = 0
  let droppedNoEngagement = 0

  for (let i = 0; i < convChannels.length; i++) {
    const channelId = convChannels[i]
    const result = convResults[i]

    if (result.status === 'rejected') {
      const err = result.reason instanceof Error ? result.reason.message : String(result.reason)
      log(`Skipping ${CHANNEL_NAMES[channelId]}: ${err}`)
      continue
    }

    for (const msg of result.value) {
      if (isBotAuthored(msg)) { droppedBotAuthored++; continue }
      if (!msg.text || msg.text.trim().length < 30) continue

      // Engagement floor. Nothing on it yet is not a top conversation.
      const reactionCount = (msg.reactions ?? []).reduce((sum, rx) => sum + (rx.count ?? 0), 0)
      const replyCountRaw = msg.reply_count ?? 0
      if (replyCountRaw < MIN_REPLIES_FOR_TOP && reactionCount < MIN_REACTIONS_FOR_TOP) {
        droppedNoEngagement++
        continue
      }

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

  const allCandidatesRaw: ConversationCandidate[] = [
    ...noUrlCandidates,
    ...Array.from(urlMap.values()).map((e) => e.candidate),
  ]

  // Dedup against yesterday's posted keys (permalink OR url). Anything we
  // surfaced yesterday is dropped from today's pool so the same thread/link
  // doesn't appear twice in a row.
  const allCandidates = allCandidatesRaw.filter(
    (c) => !dedupSet.has(c.permalink) && !(c.url && dedupSet.has(c.url))
  )
  const droppedConvDupes = allCandidatesRaw.length - allCandidates.length
  if (droppedConvDupes > 0) log(`Dedup: dropped ${droppedConvDupes} conversation candidate(s) seen yesterday`)

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

  const todayStr = now.toISODate()!

  // Header names the days actually covered, so the reader can tell at a glance
  // what the post is about: "Thursday 8/20", or "Fri 8/21 – Sun 8/23" after a gap.
  const coveredStartDt = DateTime.fromSeconds(
    Math.min(...allChannels.map((ch) => windowStart[ch])),
    { zone: 'America/Bogota' },
  ).startOf('day')
  const coveredDays = Math.max(1, Math.round(windowEndDt.diff(coveredStartDt, 'days').days))
  const dateStr = coveredDays <= 1
    ? dayStartDt.toFormat('cccc M/d')
    : `${coveredStartDt.toFormat('ccc M/d')} – ${dayStartDt.toFormat('ccc M/d')}`

  log(`Window: ${dateStr} (${coveredDays} day${coveredDays !== 1 ? 's' : ''}), dropped ${droppedBotAuthored} bot-authored, ${droppedNoEngagement} below the engagement floor`)

  // Mark the window as covered up to its right edge, not up to now — otherwise
  // the next run's left edge swallows part of today.
  const updateTimestamps = () =>
    Promise.all(allChannels.map((ch) => setLastReported(ch, windowEnd)))

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

  const allIntrosRaw: IntroCandidate[] = [...carriedIntroCandidates, ...introCandidates]
  const allIntros: IntroCandidate[] = allIntrosRaw.filter(
    (i) => !i.permalink || !dedupSet.has(i.permalink)
  )
  const droppedIntroDupes = allIntrosRaw.length - allIntros.length
  if (droppedIntroDupes > 0) log(`Dedup: dropped ${droppedIntroDupes} intro candidate(s) seen yesterday`)

  // If nothing new survives the dedup, skip the whole run (and the LLM call).
  // Brian (May 13 PM): skip only when there's literally no fresh info.
  if (allCandidates.length === 0 && allIntros.length === 0) {
    log('Skipping — no new candidates after dedup against yesterday')
    await updateTimestamps()
    return NextResponse.json({
      status: 'skipped',
      reason: 'no-new-info',
      window: dateStr,
      dropped_dupes: droppedConvDupes + droppedIntroDupes,
      dropped_bot_authored: droppedBotAuthored,
      dropped_no_engagement: droppedNoEngagement,
    })
  }

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
      window_days: coveredDays,
      dropped_bot_authored: droppedBotAuthored,
      dropped_no_engagement: droppedNoEngagement,
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
        replies_preview: c.replies.map((r) => ({
          replier: r.user_name ?? '(unresolved)',
          first_80: r.text.slice(0, 80),
        })),
      })),
      _llm_raw: lastLLMOutput,
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
      // Persist today's permalinks + URLs so tomorrow's run can dedupe against
      // them. Both lists feed the set: permalinks identify threads, URLs
      // identify shared links posted from different messages.
      const todaysKeys = [
        ...allCandidates.map((c) => c.permalink),
        ...allCandidates.map((c) => c.url ?? '').filter(Boolean),
        ...allIntros.map((i) => i.permalink).filter(Boolean),
      ]
      await Promise.all([
        clearPendingIntros(),
        updateTimestamps(),
        setLastPostedKeys(todaysKeys),
      ])
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
