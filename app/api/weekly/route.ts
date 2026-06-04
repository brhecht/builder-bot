import { NextRequest, NextResponse } from 'next/server'
import { DateTime } from 'luxon'
import {
  getBowLastWeek,
  setBowLastWeek,
  getBowLastPin,
  setBowLastPin,
  getRecentWinners,
  setRecentWinners,
} from '@/lib/kv'
import {
  getChannelMessages,
  getUserName,
  postAndGetTs,
  pinMessage,
  unpinMessage,
  makeDeepLink,
} from '@/lib/slack'
import { generateBuilderOfWeek } from '@/lib/claude'
import { BuilderScore, BuilderTopPost, RecentWinner } from '@/lib/types'

export const maxDuration = 60

// Engagement-source channels for the weekly Builder of the Week tally.
const CHANNELS = {
  SHARE_AND_DISCUSS: process.env.SLACK_CHANNEL_SHARE_AND_DISCUSS!,
  WHAT_IM_BUILDING: process.env.SLACK_CHANNEL_WHAT_IM_BUILDING!,
  GENERAL: process.env.SLACK_CHANNEL_GENERAL!,
}

const CHANNEL_NAMES: Record<string, string> = {
  [process.env.SLACK_CHANNEL_SHARE_AND_DISCUSS ?? '']: 'share-and-discuss',
  [process.env.SLACK_CHANNEL_WHAT_IM_BUILDING ?? '']: 'what-im-building',
  [process.env.SLACK_CHANNEL_GENERAL ?? '']: 'general',
}

// Engagement weights (tunable). score = reactions*REACTION_WEIGHT + replies*REPLY_WEIGHT
const REACTION_WEIGHT = 1
const REPLY_WEIGHT = 1
// A winner can't win again for this many weeks — the spotlight rotates.
const COOLDOWN_WEEKS = 4

function log(msg: string) {
  console.log(`[builder-bot:weekly] ${msg}`)
}

// Trial mode: when SLACK_BOW_TARGETS is set (comma-separated user/channel IDs),
// the announcement goes to those DMs and the auto-pin is skipped. When empty,
// the bot posts to #general and pins. Mirrors the daily bot's getRecapTargets().
function getBowTargets(): string[] {
  return (process.env.SLACK_BOW_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function getExcludeIds(): Set<string> {
  return new Set(
    (process.env.SLACK_BOW_EXCLUDE_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret (same pattern as /api/cron)
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const isTest = req.nextUrl.searchParams.get('test') === 'true'
  const isDryRun = req.nextUrl.searchParams.get('dry_run') === 'true'
  const channelOverride = isTest ? req.nextUrl.searchParams.get('channel') : null
  const lookbackDaysParam = isTest ? req.nextUrl.searchParams.get('lookback_days') : null
  const lookbackDays = lookbackDaysParam ? parseFloat(lookbackDaysParam) : 7

  // Time gate: Friday 3 PM Eastern. luxon resolves DST automatically, so a
  // single hour===15 check is correct year-round; the dual-UTC cron
  // (0 19,20 * * 5) fires on both candidate hours and only one passes.
  const now = DateTime.now().setZone('America/New_York')
  if (!isTest) {
    if (now.weekday !== 5) {
      log(`Skipping — not Friday (${now.toFormat('cccc')})`)
      return NextResponse.json({ skipped: 'not-friday' })
    }
    if (now.hour !== 15) {
      log(`Skipping — not 3 PM ET (current: ${now.toFormat('HH:mm z')})`)
      return NextResponse.json({ skipped: 'outside-window' })
    }
  } else {
    log(`Test mode — bypassing time gate (${now.toFormat('cccc HH:mm z')})`)
  }

  const currentWeek = now.toFormat("kkkk-'W'WW") // ISO week, e.g. "2026-W23"

  // Idempotency: only one announcement per ISO week (covers the dual-fire cron).
  if (!isTest) {
    const lastWeek = await getBowLastWeek()
    if (lastWeek === currentWeek) {
      log(`Skipping — already announced for ${currentWeek}`)
      return NextResponse.json({ skipped: 'already-announced', week: currentWeek })
    }
  }

  const weekStart = now.minus({ days: lookbackDays })
  const oldest = Math.floor(weekStart.toSeconds())
  const weekLabel = `week of ${weekStart.toFormat('LLL d')}`
  log(`Starting run — ${currentWeek}, window since ${weekStart.toFormat('LLL d HH:mm z')}`)

  // 1. Fetch the engagement-source channels concurrently. No thread fetches —
  //    reply_count + reactions[] both come back in conversations.history.
  const sourceChannels = [CHANNELS.SHARE_AND_DISCUSS, CHANNELS.WHAT_IM_BUILDING, CHANNELS.GENERAL]
  const results = await Promise.allSettled(
    sourceChannels.map((ch) => getChannelMessages(ch, oldest))
  )

  // 2. Aggregate engagement per author (no name resolution yet — we resolve
  //    only the winner + dry-run top N to avoid a getUserName per author).
  const excludeIds = getExcludeIds()
  const agg = new Map<string, BuilderScore>()
  const channelDiag: Record<string, number | string> = {}

  for (let i = 0; i < sourceChannels.length; i++) {
    const channelId = sourceChannels[i]
    const name = CHANNEL_NAMES[channelId] ?? channelId
    const r = results[i]
    if (r.status === 'rejected') {
      channelDiag[name] = r.reason instanceof Error ? r.reason.message : String(r.reason)
      log(`Skipping ${name}: ${channelDiag[name]}`)
      continue
    }
    channelDiag[name] = r.value.length

    for (const msg of r.value) {
      const userId = msg.user
      if (!userId || excludeIds.has(userId)) continue
      if (msg.subtype === 'bot_message') continue

      const reactions = (msg.reactions ?? []).reduce((sum, rx) => sum + (rx.count ?? 0), 0)
      const replies = msg.reply_count ?? 0
      const postScore = reactions * REACTION_WEIGHT + replies * REPLY_WEIGHT
      if (postScore === 0) continue // no engagement — can't be Builder of the Week

      const topPost: BuilderTopPost = {
        ts: msg.ts,
        permalink: makeDeepLink(channelId, msg.ts),
        text: msg.text ?? '',
        channelName: name,
        reactions,
        replies,
        score: postScore,
      }

      const existing = agg.get(userId)
      if (!existing) {
        agg.set(userId, {
          userId,
          userName: '',
          totalReactions: reactions,
          totalReplies: replies,
          postCount: 1,
          score: postScore,
          topPost,
        })
      } else {
        existing.totalReactions += reactions
        existing.totalReplies += replies
        existing.postCount += 1
        existing.score += postScore
        if (postScore > existing.topPost.score) existing.topPost = topPost
      }
    }
  }

  // 3. Cooldown: exclude anyone who won within the last COOLDOWN_WEEKS (one
  //    winner per week, so the trimmed recent list IS the last N weeks).
  const recentWinners = await getRecentWinners()
  const cooldownIds = new Set(recentWinners.map((w) => w.userId))

  // 4. Rank: score desc, then total reactions desc, then earliest standout post.
  const ranked = Array.from(agg.values())
    .filter((b) => !cooldownIds.has(b.userId))
    .sort((a, b) =>
      b.score - a.score ||
      b.totalReactions - a.totalReactions ||
      a.topPost.ts.localeCompare(b.topPost.ts)
    )

  const winner = ranked[0]

  // No eligible builder this week → skip (but mark the week so the dual-cron
  // doesn't recompute at the second firing).
  if (!winner) {
    log('Skipping — no eligible builder with engagement this week')
    if (!isTest && !channelOverride) await setBowLastWeek(currentWeek)
    return NextResponse.json({
      status: 'skipped',
      reason: 'no-info',
      week: currentWeek,
      ...(isTest && { _diag: { channels: channelDiag, cooldown: Array.from(cooldownIds) } }),
    })
  }

  // 5. Resolve the winner's display name (1 API call).
  winner.userName = await getUserName(winner.userId)

  // 6. Dry run — return the computed ranking, no post/pin.
  if (isDryRun) {
    const topN = await Promise.all(
      ranked.slice(0, 10).map(async (b) => ({
        name: b.userId === winner.userId ? winner.userName : await getUserName(b.userId),
        score: b.score,
        reactions: b.totalReactions,
        replies: b.totalReplies,
        posts: b.postCount,
        top_post: b.topPost.permalink,
      }))
    )
    return NextResponse.json({
      status: 'dry_run',
      week: currentWeek,
      window_days: lookbackDays,
      winner: { name: winner.userName, score: winner.score },
      ranked: topN,
      _diag: { channels: channelDiag, cooldown: Array.from(cooldownIds) },
    })
  }

  // 7. Generate the announcement copy (Claude, Brian's TNB voice + fallback).
  const message = await generateBuilderOfWeek({
    name: winner.userName,
    topPostText: winner.topPost.text,
    topPostLink: winner.topPost.permalink,
    totalReactions: winner.totalReactions,
    totalReplies: winner.totalReplies,
    weekLabel,
  })

  // 8. Resolve targets. Trial → DMs (no pin). Production → #general (+ pin).
  const bowTargets = getBowTargets()
  const targets = channelOverride ? [channelOverride] : bowTargets.length > 0 ? bowTargets : [CHANNELS.GENERAL]
  const isProduction = !channelOverride && bowTargets.length === 0
  log(`Posting to ${targets.length} target(s): ${targets.join(', ')} (${isProduction ? 'production/#general' : 'trial/DM'})`)

  const postResults = await Promise.allSettled(targets.map((t) => postAndGetTs(t, message)))
  const failed = postResults
    .map((r, i) => (r.status === 'rejected' ? { target: targets[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) } : null))
    .filter((x): x is { target: string; error: string } => x !== null)
  if (failed.length > 0) log(`Post failures: ${JSON.stringify(failed)}`)

  // 9. Pin in #general (production only). Unpin last week's announcement first.
  let pinned = false
  if (isProduction) {
    const generalIdx = targets.indexOf(CHANNELS.GENERAL)
    const postRes = postResults[generalIdx]
    if (postRes?.status === 'fulfilled') {
      const newTs = postRes.value
      try {
        const lastPin = await getBowLastPin()
        if (lastPin) await unpinMessage(lastPin.channel, lastPin.ts)
        await pinMessage(CHANNELS.GENERAL, newTs)
        await setBowLastPin({ channel: CHANNELS.GENERAL, ts: newTs })
        pinned = true
      } catch (err) {
        log(`Pin failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // 10. KV update on real scheduled runs (skip only on manual ?channel override).
  if (!channelOverride) {
    try {
      const newWinner: RecentWinner = { userId: winner.userId, name: winner.userName, week: currentWeek }
      const trimmed = [...recentWinners.filter((w) => w.week !== currentWeek), newWinner].slice(-COOLDOWN_WEEKS)
      await Promise.all([setBowLastWeek(currentWeek), setRecentWinners(trimmed)])
    } catch (err) {
      log(`KV update failed after post (non-fatal): ${err}`)
    }
  } else {
    log('Test override — skipping KV state update')
  }

  return NextResponse.json({
    status: 'posted',
    week: currentWeek,
    winner: winner.userName,
    score: winner.score,
    reactions: winner.totalReactions,
    replies: winner.totalReplies,
    targets,
    pinned,
    mode: isProduction ? 'production' : 'trial',
    failed,
    test_override: !!channelOverride,
  })
}
