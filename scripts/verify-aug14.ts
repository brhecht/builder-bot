// Replays the week of Aug 14 — the run Chuck flagged on Aug 21 — through the
// reconcile logic, and prints what the Friday message would say now.
// Run: npx tsx scripts/verify-aug14.ts
import { formatLeaderboard, pickBowSkipReason, buildBowNote, TOP_N } from '../lib/leaderboard'
import { BuilderScore, AllTimeEntry } from '../lib/types'

const noPost = { ts: '', permalink: '', text: '', channelName: '', reactions: 0, replies: 0, score: 0 }

function b(userId: string, userName: string, score: number, posts: number, rxR = 0, rxG = 0, rep = 0): BuilderScore {
  return {
    userId, userName, posts, reactionsReceived: rxR, reactionsGiven: rxG, repliesWritten: rep,
    totalReactions: rxR, totalReplies: 0, postCount: posts, score,
    topPost: { ...noPost, ts: `${userId}-1`, permalink: `https://slack.example/${userId}` },
  }
}

// Exactly the board the bot posted on Aug 21.
const weeklyRanked: BuilderScore[] = [
  b('U-ANURAG', 'Anurag', 36, 4, 5, 0, 2),
  b('U-JEFF', 'Jeff Latz', 24, 3),
  b('U-SCOTT', 'Scott Werner', 19, 2),
  b('U-JARON', 'Jaron Rubenstein', 15, 1),
  b('U-CHUCK', 'Chuck', 11, 1),
]
const allTime: AllTimeEntry[] = [
  { userId: 'U-JARON', name: 'Jaron Rubenstein', totalPts: 563, weeksParticipated: 9, lastActive: '2026-W34' },
  { userId: 'U-SCOTT', name: 'Scott Werner', totalPts: 560, weeksParticipated: 9, lastActive: '2026-W34' },
  { userId: 'U-CHUCK', name: 'Chuck', totalPts: 442, weeksParticipated: 9, lastActive: '2026-W34' },
]

// Anurag won on Jul 24 (2026-W30) and is inside the 4-week cooldown.
const cooldownIds = new Set(['U-ANURAG', 'U-JARON', 'U-SHANIF', 'U-X'])
const eligible = weeklyRanked.filter((x) => !cooldownIds.has(x.userId) && x.posts > 0)
const winner = eligible[0]
const topScorer = weeklyRanked[0]
const reason = pickBowSkipReason(topScorer, winner, cooldownIds)
const note = buildBowNote(reason, topScorer)

const checks: Array<[string, boolean]> = [
  ['winner is Jeff Latz (cooldown still applies)', winner.userId === 'U-JEFF'],
  ['skip reason is cooldown, not silence', reason === 'cooldown'],
  ['note names Anurag', !!note && note.includes('Anurag')],
]

const post = formatLeaderboard(weeklyRanked, allTime, 'week of Aug 14', winner.userId, note)
checks.push(['trophy sits on the winner row', post.includes('*Jeff Latz* — 24 Tendys 🐓 🏆')])
checks.push(['top scorer keeps the gold medal', post.includes('🥇 *Anurag* — 36 Tendys 🐓')])
checks.push(['post explains the gap', post.includes('Builder of the Week')])

// Winner outside the top 5 must still appear.
const deep = [...weeklyRanked, b('U-DEEP', 'Deep Cut', 4, 1)]
const deepPost = formatLeaderboard(deep, allTime, 'week of Aug 14', 'U-DEEP', 'test')
checks.push(['winner below top 5 is still listed', deepPost.includes('*Deep Cut* — 4 Tendys 🐓 🏆')])

console.log(post)
console.log('\n--- checks ---')
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}
process.exit(failed === 0 ? 0 : 1)
