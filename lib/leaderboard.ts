import { BuilderScore, AllTimeEntry } from './types'

// Leaderboard point weights (tunable).
// score = posts*POST + reactionsReceived*REACTION_RECEIVED + reactionsGiven*REACTION_GIVEN + repliesWritten*REPLY_WRITTEN
export const POINTS = {
  POST: 5,
  REACTION_RECEIVED: 2,
  REACTION_GIVEN: 1,
  REPLY_WRITTEN: 3,
} as const

export const COOLDOWN_WEEKS = 4   // BOW winner no-repeat window
export const TOP_N = 5            // leaderboard positions shown in Friday post

export type BowSkipReason = 'cooldown' | 'no-post' | null

// Why the top scorer is not Builder of the Week, when they are not. Both rules
// already existed in the route; neither was ever stated in the post, so the two
// halves of the Friday message could contradict each other in silence.
export function pickBowSkipReason(
  topScorer: BuilderScore | undefined,
  winner: BuilderScore | undefined,
  cooldownIds: Set<string>,
): BowSkipReason {
  if (!winner || !topScorer || topScorer.userId === winner.userId) return null
  if (cooldownIds.has(topScorer.userId)) return 'cooldown'
  if (topScorer.posts === 0) return 'no-post'
  return null
}

export function buildBowNote(reason: BowSkipReason, topScorer: BuilderScore | undefined): string | null {
  if (!reason || !topScorer) return null
  const name = topScorer.userName || topScorer.userId
  if (reason === 'cooldown') {
    return `${name} tops the board but has won in the last ${COOLDOWN_WEEKS} weeks, so it goes to the next builder up.`
  }
  return `${name} tops the board on replies and reactions. Builder of the Week goes to the top builder who posted.`
}

// Deterministic leaderboard post — no Claude call needed.
// winnerId + bowNote reconcile this post with the Builder of the Week post above
// it. Before Aug 24 the two could disagree in the same message (Jeff named while
// Anurag sat on top with 36 to 24) with nothing said about why.
export function formatLeaderboard(
  weeklyRanked: BuilderScore[],
  allTime: AllTimeEntry[],
  weekLabel: string,
  winnerId: string,
  bowNote: string | null,
): string {
  const medals = ['🥇', '🥈', '🥉']
  const topN = weeklyRanked.slice(0, TOP_N)

  const lines: string[] = [`*📊 Community Leaderboard — ${weekLabel}*`, '']

  for (let i = 0; i < topN.length; i++) {
    const b = topN[i]
    const prefix = i < 3 ? medals[i] : `${i + 1}.`
    const badge = b.userId === winnerId ? ' 🏆' : ''
    lines.push(`${prefix} *${b.userName}* — ${b.score} Tendys 🐓${badge}`)
    if (i === 0) {
      lines.push(
        `   _${b.posts} post${b.posts !== 1 ? 's' : ''} · ${b.reactionsReceived} rxn received · ${b.reactionsGiven} rxn given · ${b.repliesWritten} replies_`,
      )
    }
  }

  // If the winner placed below TOP_N their row is missing entirely, which reads
  // as the two posts describing different weeks. Show it.
  const winnerIndex = weeklyRanked.findIndex((b) => b.userId === winnerId)
  if (winnerIndex >= TOP_N) {
    const w = weeklyRanked[winnerIndex]
    lines.push(`${winnerIndex + 1}. *${w.userName}* — ${w.score} Tendys 🐓 🏆`)
  }

  if (bowNote) {
    lines.push('')
    lines.push(`_🏆 = Builder of the Week. ${bowNote}_`)
  }

  const topAllTime = [...allTime].sort((a, b) => b.totalPts - a.totalPts).slice(0, 3)
  if (topAllTime.length > 0) {
    lines.push('')
    lines.push(`*All-time:* ${topAllTime.map((e) => `${e.name} (${e.totalPts} 🐓)`).join(' · ')}`)
  }

  lines.push('')
  lines.push(
    `_Scoring: post +${POINTS.POST} · rxn received +${POINTS.REACTION_RECEIVED} · rxn given +${POINTS.REACTION_GIVEN} · reply +${POINTS.REPLY_WRITTEN} Tendys 🐓_`,
  )

  return lines.join('\n')
}

