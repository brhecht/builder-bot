// Checks the join mark (TNB-674) end to end against mocks. Nothing here
// touches Slack or Linear: every dep is an in-memory fake that records what
// would have been written.
// Run: npx tsx scripts/verify-join-mark.ts
import assert from 'node:assert/strict'
import {
  buildJoinMarkComment, getJoinMarkMode, handleJoinMark, JoinMarkChange, JoinMarkConfig, JoinMarkDeps,
  planJoinMark, stageNumber,
} from '../lib/join-mark'
import { CrmCard, SlackUser } from '../lib/types'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (err) {
    console.log(`FAIL ${name}`)
    throw err
  }
}

function card(identifier: string, title: string, description: string, stateName: string, labels: string[] = [],
  stateType = 'started', teamKey = 'CRM'): CrmCard {
  return { id: `uuid-${identifier}`, identifier, title, description, url: `https://linear.app/x/${identifier}`, teamKey, stateName, stateType, labels }
}
function user(id: string, realName: string, extra: Partial<SlackUser> = {}, email?: string): SlackUser {
  return { id, real_name: realName, profile: { real_name: realName, email }, ...extra }
}

// Kenan Andrews, Oct 14 2026: invited Oct 12, card at 2. Invited, no TNB SLACK.
const KENAN_CARD = card('CRM-243', 'Kenan Andrews', [
  'Completion metric: Kenan has joined the TNB Slack, or has said no.',
  '',
  '* Email: [andrews.kenan06@gmail.com](<mailto:andrews.kenan06@gmail.com>)',
  '* Slack invite sent Mon Oct 12. Member ID `U0C8L5M74AE`, join not yet confirmed.',
].join('\n'), '2. Invited', ['Attended an event', 'TNB MEMBERS'], 'unstarted')
// Gilad Rotem: already introduced, already labeled.
const GILAD_CARD = card('CRM-98', 'Gilad Rotem', '* Email: [gldrtm@gmail.com](<mailto:gldrtm@gmail.com>)\n* Slack member ID: U0C27K5BGTX',
  '5. Introduced', ['TNB SLACK', 'TNB MEMBERS'])
// A 7. Active Member card that lost its label (Paul Pierson, Oct 14).
const PAUL_CARD = card('CRM-95', 'Paul Pierson', '* Email: [pierson.paul@bcgbrighthouse.com](<mailto:pierson.paul@bcgbrighthouse.com>)',
  '7. Active Member', ['TNB MEMBERS'], 'completed')
// A status with no number.
const KRIS_CARD = card('CRM-4', 'Kris Mondlane', '| Email | [kris@agentichighway.ai](<mailto:kris@agentichighway.ai>) |',
  'Deactivated account', ['TNB MEMBERS'])

interface World { users: SlackUser[]; cards: CrmCard[] }
function makeDeps(world: World) {
  const marks: { card: string; change: JoinMarkChange }[] = []
  const comments: { card: string; body: string }[] = []
  const logs: string[] = []
  let failMark = false
  let failComment = false
  const deps: JoinMarkDeps = {
    getUser: async (id) => world.users.find((u) => u.id === id) ?? null,
    findCrmCardsByText: async (t) => world.cards.filter((c) => c.description.toLowerCase().includes(t.toLowerCase())),
    findCrmCardsByTitle: async (t) => world.cards.filter((c) => c.title.toLowerCase() === t.toLowerCase()),
    markCard: async (c, change) => { if (failMark) throw new Error('state not found'); marks.push({ card: c.identifier, change }) },
    commentOnCrmCard: async (c, body) => { if (failComment) throw new Error('rate limited'); comments.push({ card: c.identifier, body }) },
    log: (m) => logs.push(m),
    now: () => new Date('2026-10-14T15:00:00Z'),
  }
  return { deps, marks, comments, logs, failMarkNext: () => { failMark = true }, failCommentNext: () => { failComment = true } }
}
const live: JoinMarkConfig = { mode: 'live', crmTeamKey: 'CRM', slackLabel: 'TNB SLACK', acceptedState: '4. Accepted' }

const kenan = user('U0C8L5M74AE', 'Kenan Andrews', {}, 'andrews.kenan06@gmail.com')

async function main() {
  await test('flag defaults to off', () => {
    assert.equal(getJoinMarkMode({}), 'off')
    assert.equal(getJoinMarkMode({ JOIN_MARK_ENABLED: 'yes' }), 'off')
    assert.equal(getJoinMarkMode({ JOIN_MARK_ENABLED: 'dry_run' }), 'dry_run')
    assert.equal(getJoinMarkMode({ JOIN_MARK_ENABLED: 'TRUE' }), 'live')
  })

  await test('stage numbers', () => {
    assert.equal(stageNumber('2. Invited'), 2)
    assert.equal(stageNumber('4. Accepted'), 4)
    assert.equal(stageNumber('Deactivated account'), null)
  })

  await test('plan: card at 2 gets the label and moves to 4', () => {
    assert.deepEqual(planJoinMark(KENAN_CARD, live), { addLabel: 'TNB SLACK', moveToState: '4. Accepted' })
  })

  await test('plan: nothing moves backwards or out of a closed or unnumbered status', () => {
    assert.deepEqual(planJoinMark(GILAD_CARD, live), {})
    assert.deepEqual(planJoinMark(PAUL_CARD, live), { addLabel: 'TNB SLACK' })
    assert.deepEqual(planJoinMark(KRIS_CARD, live), { addLabel: 'TNB SLACK' })
  })

  await test('plan: label match ignores case and spaces', () => {
    assert.deepEqual(planJoinMark({ ...GILAD_CARD, labels: [' tnb slack '] }, live), {})
  })

  await test('off: nothing runs', async () => {
    const w = makeDeps({ users: [kenan], cards: [KENAN_CARD] })
    const r = await handleJoinMark(kenan.id, w.deps, { ...live, mode: 'off' })
    assert.equal(r.status, 'off')
    assert.equal(w.marks.length + w.comments.length, 0)
  })

  await test('pending invite is not a join', async () => {
    const pending = user(kenan.id, 'Kenan Andrews', { is_invited_user: true }, 'andrews.kenan06@gmail.com')
    const w = makeDeps({ users: [pending], cards: [KENAN_CARD] })
    const r = await handleJoinMark(kenan.id, w.deps, live)
    assert.equal(r.reason, 'joiner_invite_pending')
    assert.equal(w.marks.length, 0)
  })

  await test('live: real join marks the card and comments once', async () => {
    const w = makeDeps({ users: [kenan], cards: [KENAN_CARD] })
    const r = await handleJoinMark(kenan.id, w.deps, live)
    assert.equal(r.status, 'marked')
    assert.equal(r.matchedBy, 'slack_id')
    assert.deepEqual(w.marks, [{ card: 'CRM-243', change: { addLabel: 'TNB SLACK', moveToState: '4. Accepted' } }])
    assert.equal(w.comments.length, 1)
    assert.match(w.comments[0].body, /Joined TNB Slack Wed Oct 14, 2026/)
    assert.match(w.comments[0].body, /Moved to 4\. Accepted/)
    assert.doesNotMatch(w.comments[0].body, /—/)
  })

  await test('live: card found by Slack email when the card has no Slack ID', async () => {
    const noId = { ...KENAN_CARD, description: '* Email: [andrews.kenan06@gmail.com](<mailto:andrews.kenan06@gmail.com>)' }
    const w = makeDeps({ users: [kenan], cards: [noId] })
    const r = await handleJoinMark(kenan.id, w.deps, live)
    assert.equal(r.status, 'marked')
    assert.equal(r.matchedBy, 'email')
  })

  await test('dry_run: plans and logs, writes nothing', async () => {
    const w = makeDeps({ users: [kenan], cards: [KENAN_CARD] })
    const r = await handleJoinMark(kenan.id, w.deps, { ...live, mode: 'dry_run' })
    assert.equal(r.status, 'dry_run')
    assert.deepEqual(r.change, { addLabel: 'TNB SLACK', moveToState: '4. Accepted' })
    assert.equal(w.marks.length + w.comments.length, 0)
    assert.ok(w.logs.some((l) => l.includes('join-mark dry_run') && l.includes('CRM-243')))
  })

  await test('already marked: no write, no comment', async () => {
    const gilad = user('U0C27K5BGTX', 'Gilad Rotem', {}, 'gldrtm@gmail.com')
    const w = makeDeps({ users: [gilad], cards: [GILAD_CARD] })
    const r = await handleJoinMark(gilad.id, w.deps, live)
    assert.equal(r.reason, 'already_marked')
    assert.equal(w.marks.length + w.comments.length, 0)
  })

  await test('no card or two cards: no write', async () => {
    const w1 = makeDeps({ users: [kenan], cards: [] })
    assert.equal((await handleJoinMark(kenan.id, w1.deps, live)).reason, 'no_crm_card')
    const w2 = makeDeps({ users: [kenan], cards: [KENAN_CARD, { ...KENAN_CARD, id: 'uuid-dup', identifier: 'CRM-999' }] })
    assert.equal((await handleJoinMark(kenan.id, w2.deps, live)).reason, 'ambiguous_crm_card')
    assert.equal(w1.marks.length + w2.marks.length, 0)
  })

  await test('card outside the CRM team is never touched', async () => {
    const w = makeDeps({ users: [kenan], cards: [{ ...KENAN_CARD, teamKey: 'TNB' }] })
    const r = await handleJoinMark(kenan.id, w.deps, live)
    assert.equal(r.reason, 'card_outside_crm_team')
    assert.equal(w.marks.length, 0)
  })

  await test('guests and deactivated users are not joins', async () => {
    for (const extra of [{ is_restricted: true }, { deleted: true }, { is_bot: true }]) {
      const w = makeDeps({ users: [user(kenan.id, 'Kenan Andrews', extra, 'andrews.kenan06@gmail.com')], cards: [KENAN_CARD] })
      assert.equal((await handleJoinMark(kenan.id, w.deps, live)).reason, 'joiner_not_active_member')
    }
  })

  await test('mark failure: error, no comment', async () => {
    const w = makeDeps({ users: [kenan], cards: [KENAN_CARD] })
    w.failMarkNext()
    const r = await handleJoinMark(kenan.id, w.deps, live)
    assert.equal(r.status, 'error')
    assert.equal(r.reason, 'mark_failed')
    assert.equal(w.comments.length, 0)
  })

  await test('comment failure after the mark: still marked, logged', async () => {
    const w = makeDeps({ users: [kenan], cards: [KENAN_CARD] })
    w.failCommentNext()
    const r = await handleJoinMark(kenan.id, w.deps, live)
    assert.equal(r.status, 'marked')
    assert.equal(r.commentError, 'rate limited')
    assert.ok(w.logs.some((l) => l.includes('join-mark comment failed')))
  })

  await test('comment text for a label-only change', () => {
    const body = buildJoinMarkComment({ addLabel: 'TNB SLACK' }, new Date('2026-10-14T15:00:00Z'))
    assert.match(body, /Added TNB SLACK/)
    assert.doesNotMatch(body, /Moved to/)
  })

  console.log(`\n${passed} checks passed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
