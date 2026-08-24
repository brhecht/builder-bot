import { NextRequest, NextResponse } from 'next/server'
import { DateTime } from 'luxon'
import {
  getBowLastWeek,
  setBowLastWeek,
  getBowLastPin,
  setBowLastPin,
  getRecentWinners,
  setRecentWinners,
  getAllTimeLeaderboard,
  setAllTimeLeaderboard,
} from '@/lib/kv'
import {
  getChannelMessages,
  getUserName,
  postAndGetTs,
  pinMessage,
  unpinMessage,
  makeDeepLink,
  getReplyAuthors,
  isBotAuthored,
} from '@/lib/slack'
import { generateBuilderOfWeek } from '@/lib/claude'
import { BuilderScore, BuilderTopPost, RecentWinner, AllTimeEntry } from '@/lib/types'
import {
  POINTS,
  COOLDOWN_WEEKS,
  TOP_N,
  formatLeaderboard,
  pickBowSkipReason,
  buildBowNote,
} from '@/lib/leaderboard'

export const maxDuration = 60

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

const MAX_REPLY_THREADS = 30        // max threads to fetch reply-authors from (per channel)

function log(msg: string) {
  console.log(`[builder-bot:weekly] ${msg}`)
}

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

// Upsert a member's weekly points into the all-time map.
function mergeAllTime(
  allTimeMap: Map<string, AllTimeEntry>,
  b: BuilderScore,
  currentWeek: string,
): void {
  const existing = allTimeMap.get(b.userId)
  if (!existing) {
    allTimeMap.set(b.userId, {
      userId: b.userId,
      name: b.userName || b.userId,
      totalPts: b.score,
      weeksParticipated: 1,
      lastActive: currentWeek,
    })
  } else {
    existing.totalPts += b.score
    existing.weeksParticipated += 1
    existing.lastActive = currentWeek
    if (b.userName) existing.name = b.userName // keep name fresh
  }
}

export async function GET(req: NextRequest) {
  const isTest = req.nextUrl.searchParams.get('test') === 'true'

  const auth = req.headers.get('authorization')
  const querySecret = isTest ? req.nextUrl.searchParams.get('secret') : null
  const validAuth =
    auth === `Bearer ${process.env.CRON_SECRET}` ||
    (isTest && querySecret === process.env.CRON_SECRET)
  if (process.env.CRON_SECRET && !validAuth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const isDryRun = req.nextUrl.searchParams.get('dry_run') === 'true'
  const channelOverride = isTest ? req.nextUrl.searchParams.get('channel') : null
  const lookbackDaysParam = isTest ? req.nextUrl.searchParams.get('lookback_days') : null
  const lookbackDays = lookbackDaysParam ? parseFloat(lookbackDaysParam) : 7

  // Friday 3 PM Eastern gate. Dual-UTC cron (19:00 + 20:00) covers both EDT and EST;
  // only one passes the hour===15 ET check. luxon resolves DST automatically.
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

  const currentWeek = now.toFormat("kkkk-'W'WW")

  // Idempotency: one announcement per ISO week.
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

  // ── 1. Fetch messages from source channels concurrently ──────────────────────
  const sourceChannels = [CHANNELS.SHARE_AND_DISCUSS, CHANNELS.WHAT_IM_BUILDING, CHANNELS.GENERAL]
  const fetchResults = await Promise.allSettled(
    sourceChannels.map((ch) => getChannelMessages(ch, oldest)),
  )

  const excludeIds = getExcludeIds()
  const agg = new Map<string, BuilderScore>()
  const channelDiag: Record<string, number | string> = {}

  // Threads queued for reply-author fetching (capped per channel).
  const replyThreads: Array<{ channelId: string; parentTs: string }> = []

  // ── 2. First pass: posts, reactions received, reactions given ────────────────
  for (let i = 0; i < sourceChannels.length; i++) {
    const channelId = sourceChannels[i]
    const name = CHANNEL_NAMES[channelId] ?? channelId
    const r = fetchResults[i]

    if (r.status === 'rejected') {
      channelDiag[name] = r.reason instanceof Error ? r.reason.message : String(r.reason)
      log(`Skipping ${name}: ${channelDiag[name]}`)
      continue
    }
    channelDiag[name] = r.value.length

    let threadCount = 0
    for (const msg of r.value) {
      const userId = msg.user
      if (!userId || isBotAuthored(msg)) continue

      const reactions = (msg.reactions ?? []).reduce((sum, rx) => sum + (rx.count ?? 0), 0)
      const replyCount = msg.reply_count ?? 0

      // Credit the author for posting + reactions received.
      if (!excludeIds.has(userId)) {
        const postPts = POINTS.POST + reactions * POINTS.REACTION_RECEIVED

        // Which of an author's posts is "the standout" is ranked on engagement
        // received, replies included. Ranking on postPts alone made every
        // zero-reaction post tie at 5 and handed the slot to whichever came
        // first, which is how a post with nothing on it got written up as the
        // one that moved the needle most (Aug 21).
        const postEngagement = reactions * POINTS.REACTION_RECEIVED + replyCount * POINTS.REPLY_WRITTEN

        const topPost: BuilderTopPost = {
          ts: msg.ts,
          permalink: makeDeepLink(channelId, msg.ts),
          text: msg.text ?? '',
          channelName: name,
          reactions,
          replies: replyCount,
          score: postEngagement,
        }

        const existing = agg.get(userId)
        if (!existing) {
          agg.set(userId, {
            userId,
            userName: '',
            posts: 1,
            reactionsReceived: reactions,
            reactionsGiven: 0,
            repliesWritten: 0,
            totalReactions: reactions,
            totalReplies: replyCount,
            postCount: 1,
            score: postPts,
            topPost,
          })
        } else {
          existing.posts += 1
          existing.reactionsReceived += reactions
          existing.totalReactions += reactions
          existing.totalReplies += replyCount
          existing.postCount += 1
          existing.score += postPts
          if (postEngagement > existing.topPost.score) existing.topPost = topPost
        }
      }

      // Credit each reactor (reactions[].users[] — requires reactions:read scope).
      for (const rx of msg.reactions ?? []) {
        for (const reactorId of rx.users ?? []) {
          if (!reactorId || reactorId === userId || excludeIds.has(reactorId)) continue
          const re = agg.get(reactorId)
          if (!re) {
            agg.set(reactorId, {
              userId: reactorId,
              userName: '',
              posts: 0,
              reactionsReceived: 0,
              reactionsGiven: 1,
              repliesWritten: 0,
              totalReactions: 0,
              totalReplies: 0,
              postCount: 0,
              score: POINTS.REACTION_GIVEN,
              topPost: { ts: '', permalink: '', text: '', channelName: '', reactions: 0, replies: 0, score: 0 },
            })
          } else {
            re.reactionsGiven += 1
            re.score += POINTS.REACTION_GIVEN
          }
        }
      }

      // Queue threads for reply-author tracking (capped).
      if (replyCount > 0 && threadCount < MAX_REPLY_THREADS) {
        replyThreads.push({ channelId, parentTs: msg.ts })
        threadCount++
      }
    }
  }

  // ── 3. Second pass: reply authors ────────────────────────────────────────────
  if (replyThreads.length > 0) {
    log(`Fetching reply authors for ${replyThreads.length} threads`)
    const replyResults = await Promise.allSettled(
      replyThreads.map(({ channelId, parentTs }) => getReplyAuthors(channelId, parentTs)),
    )
    for (const r of replyResults) {
      if (r.status === 'rejected') continue
      for (const replyUserId of r.value) {
        if (excludeIds.has(replyUserId)) continue
        const re = agg.get(replyUserId)
        if (!re) {
          agg.set(replyUserId, {
            userId: replyUserId,
            userName: '',
            posts: 0,
            reactionsReceived: 0,
            reactionsGiven: 0,
            repliesWritten: 1,
            totalReactions: 0,
            totalReplies: 0,
            postCount: 0,
            score: POINTS.REPLY_WRITTEN,
            topPost: { ts: '', permalink: '', text: '', channelName: '', reactions: 0, replies: 0, score: 0 },
          })
        } else {
          re.repliesWritten += 1
          re.score += POINTS.REPLY_WRITTEN
        }
      }
    }
  }

  // ── 4. Rank: score desc → reactions received desc → earliest top post ────────
  const allScored = Array.from(agg.values()).filter((b) => b.score > 0)

  const weeklyRanked = allScored.sort(
    (a, b) =>
      b.score - a.score ||
      b.reactionsReceived - a.reactionsReceived ||
      a.topPost.ts.localeCompare(b.topPost.ts),
  )

  // BOW eligibility: cooldown + must have at least 1 original post (needs a topPost for the narrative).
  const recentWinners = await getRecentWinners()
  const cooldownIds = new Set(recentWinners.map((w) => w.userId))
  const bowEligible = weeklyRanked.filter((b) => !cooldownIds.has(b.userId) && b.posts > 0)
  const winner = bowEligible[0]

  // Why the top scorer was passed over, if they were. This is the reconcile
  // half of the Aug 21 defect: the rule existed, it was just never stated.
  const topScorer = weeklyRanked[0]
  const skipReason = pickBowSkipReason(topScorer, winner, cooldownIds)

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

  // ── 5. Resolve display names (top N + winner, batched) ──────────────────────
  const usersToResolve = new Set([
    winner.userId,
    ...(topScorer ? [topScorer.userId] : []),
    ...weeklyRanked.slice(0, TOP_N).map((b) => b.userId),
  ])
  await Promise.all(
    Array.from(usersToResolve).map(async (uid) => {
      const name = await getUserName(uid)
      const entry = agg.get(uid)
      if (entry) entry.userName = name
    }),
  )

  // ── 6. Dry run ───────────────────────────────────────────────────────────────
  if (isDryRun) {
    return NextResponse.json({
      status: 'dry_run',
      week: currentWeek,
      window_days: lookbackDays,
      winner: { name: winner.userName, score: winner.score, rank: weeklyRanked.findIndex((b) => b.userId === winner.userId) + 1 },
      top_scorer: topScorer ? { name: topScorer.userName || topScorer.userId, score: topScorer.score } : null,
      bow_skip_reason: skipReason,
      weekly_leaderboard: weeklyRanked.slice(0, TOP_N).map((b, i) => ({
        rank: i + 1,
        name: b.userName || b.userId,
        score: b.score,
        posts: b.posts,
        reactionsReceived: b.reactionsReceived,
        reactionsGiven: b.reactionsGiven,
        repliesWritten: b.repliesWritten,
      })),
      _diag: {
        channels: channelDiag,
        cooldown: Array.from(cooldownIds),
        reply_threads_fetched: replyThreads.length,
      },
    })
  }

  // ── 7. Update all-time leaderboard ───────────────────────────────────────────
  const allTime = await getAllTimeLeaderboard()
  const allTimeMap = new Map<string, AllTimeEntry>(allTime.map((e) => [e.userId, e]))
  for (const b of allScored) mergeAllTime(allTimeMap, b, currentWeek)
  const updatedAllTime = Array.from(allTimeMap.values())

  // ── 8. Generate BOW announcement (Claude, Brian's voice) ─────────────────────
  // isTopEngagement gates the "most engagement in the community" claim. On Aug 21
  // the winner's standout post had zero reactions and zero replies and the copy
  // still said it moved the needle most. It now only says that when it is true.
  const winnerPostReactions = winner.topPost.reactions
  const winnerPostReplies = winner.topPost.replies
  const isTopEngagement =
    !!topScorer &&
    topScorer.userId === winner.userId &&
    winnerPostReactions + winnerPostReplies > 0

  const bowMessage = await generateBuilderOfWeek({
    name: winner.userName,
    topPostText: winner.topPost.text,
    topPostLink: winner.topPost.permalink,
    totalReactions: winnerPostReactions,
    totalReplies: winnerPostReplies,
    isTopEngagement,
    weekLabel,
  })

  // ── 9. Format leaderboard post (deterministic) ───────────────────────────────
  const bowNote = buildBowNote(skipReason, topScorer)
  const leaderboardMessage = formatLeaderboard(weeklyRanked, updatedAllTime, weekLabel, winner.userId, bowNote)

  // ── 10. Resolve posting targets ──────────────────────────────────────────────
  const bowTargets = getBowTargets()
  const targets = channelOverride
    ? [channelOverride]
    : bowTargets.length > 0
    ? bowTargets
    : [CHANNELS.GENERAL]
  const isProduction = !channelOverride && bowTargets.length === 0
  log(`Posting to ${targets.join(', ')} (${isProduction ? 'production' : 'trial'})`)

  // ── 11. Post BOW announcement (post 1) ───────────────────────────────────────
  const bowPostResults = await Promise.allSettled(targets.map((t) => postAndGetTs(t, bowMessage)))

  // ── 12. Post leaderboard (post 2, same targets) ──────────────────────────────
  const lbPostResults = await Promise.allSettled(targets.map((t) => postAndGetTs(t, leaderboardMessage)))

  const failed = [
    ...bowPostResults.map((r, i) =>
      r.status === 'rejected'
        ? { target: targets[i], post: 'bow', error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
        : null,
    ),
    ...lbPostResults.map((r, i) =>
      r.status === 'rejected'
        ? { target: targets[i], post: 'leaderboard', error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
        : null,
    ),
  ].filter((x): x is { target: string; post: string; error: string } => x !== null)

  if (failed.length > 0) log(`Post failures: ${JSON.stringify(failed)}`)

  // ── 13. Pin BOW announcement in #general (production only) ───────────────────
  let pinned = false
  if (isProduction) {
    const generalIdx = targets.indexOf(CHANNELS.GENERAL)
    const postRes = bowPostResults[generalIdx]
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

  // ── 14. Persist KV state (skip on manual channel override) ──────────────────
  if (!channelOverride) {
    try {
      const newWinner: RecentWinner = { userId: winner.userId, name: winner.userName, week: currentWeek }
      const trimmed = [...recentWinners.filter((w) => w.week !== currentWeek), newWinner].slice(-COOLDOWN_WEEKS)
      await Promise.all([
        setBowLastWeek(currentWeek),
        setRecentWinners(trimmed),
        setAllTimeLeaderboard(updatedAllTime),
      ])
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
    bow_skip_reason: skipReason,
    targets,
    pinned,
    mode: isProduction ? 'production' : 'trial',
    failed,
    test_override: !!channelOverride,
    leaderboard_top5: weeklyRanked.slice(0, TOP_N).map((b, i) => ({
      rank: i + 1,
      name: b.userName || b.userId,
      score: b.score,
    })),
  })
}
