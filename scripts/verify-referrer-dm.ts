// Checks the referrer intro DM (TNB-633) end to end against mocks. Nothing
// here touches Slack, Linear or KV: every dep is an in-memory fake that
// records what would have been sent.
// Run: npx tsx scripts/verify-referrer-dm.ts
import assert from 'node:assert/strict'
import {
  buildCrmComment, buildReferrerDm, cleanReferrerName, getReferrerDmMode, handleConfirmedJoin,
  parseEmails, parseReferredBy, parseSlackIds, ReferrerDmConfig, ReferrerDmDeps,
} from '../lib/referrer-dm'
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

// --- fixtures, shaped like the real TNB CRM cards (Oct 13 2026) ---------------

function card(identifier: string, title: string, description: string, stateName = '4. Accepted', teamKey = 'CRM'): CrmCard {
  return { id: `uuid-${identifier}`, identifier, title, description, url: `https://linear.app/x/${identifier}`, teamKey, stateName, stateType: 'started' }
}
function user(id: string, realName: string, extra: Partial<SlackUser> = {}, email?: string): SlackUser {
  return { id, real_name: realName, profile: { real_name: realName, email }, ...extra }
}

const JARON_CARD = card('CRM-27', 'Jaron Rubenstein', [
  '|  |  |', '| -- | -- |',
  '| Email | [jaron@rubensteinventures.com](<mailto:jaron@rubensteinventures.com>) |',
  '| Slack member ID | `U0AUJ54MPUG` |',
  '| Referred by | — |',
].join('\n'), '7. Active Member')
const BRANDY_CARD = card('CRM-300', 'Brandy Test', [
  '**Source:** application form at [thenewbuilder.ai/apply](<http://thenewbuilder.ai/apply>), 2026-10-12.',
  '',
  '* Email: [brandy@example.com](<mailto:brandy@example.com>)',
  '* Referred by: Jaron Rubenstein (shared info about community in our PEF WhatsApp)',
].join('\n'))

interface World { users: SlackUser[]; cards: CrmCard[] }
function makeDeps(world: World) {
  const sent: { to: string; text: string }[] = []
  const comments: { card: string; body: string }[] = []
  const claimed = new Set<string>()
  const logs: string[] = []
  const calls = { getUser: 0 }
  let failDm = false
  const deps: ReferrerDmDeps = {
    getUser: async (id) => { calls.getUser++; return world.users.find((u) => u.id === id) ?? null },
    lookupUserByEmail: async (email) => world.users.find((u) => u.profile?.email === email) ?? null,
    listUsers: async () => world.users,
    findCrmCardsByText: async (t) => world.cards.filter((c) => c.description.toLowerCase().includes(t.toLowerCase())),
    findCrmCardsByTitle: async (t) => world.cards.filter((c) => c.title.toLowerCase() === t.toLowerCase()),
    sendDm: async (to, text) => { if (failDm) throw new Error('channel_not_found'); sent.push({ to, text }) },
    commentOnCrmCard: async (c, body) => { comments.push({ card: c.identifier, body }) },
    claimDm: async (id) => { if (claimed.has(id)) return false; claimed.add(id); return true },
    releaseDm: async (id) => { claimed.delete(id) },
    log: (m) => logs.push(m),
    now: () => new Date('2026-10-13T15:00:00Z'),
  }
  return { deps, sent, comments, claimed, logs, calls, failDmNext: () => { failDm = true } }
}
const live: ReferrerDmConfig = { mode: 'live', crmTeamKey: 'CRM', introChannelId: 'C0INTRO123', skipReferrerIds: ['U0AQPP9T4QZ'] }

const jaron = user('U0AUJ54MPUG', 'Jaron Rubenstein', {}, 'jaron@rubensteinventures.com')
const brandy = user('U0NEW00001', 'Brandy Test', {}, 'brandy@example.com')

async function main() {
  // --- parsing ---------------------------------------------------------------

  await test('flag defaults to off', () => {
    assert.equal(getReferrerDmMode({}), 'off')
    assert.equal(getReferrerDmMode({ REFERRER_DM_ENABLED: 'false' }), 'off')
    assert.equal(getReferrerDmMode({ REFERRER_DM_ENABLED: 'yes' }), 'off')
    assert.equal(getReferrerDmMode({ REFERRER_DM_ENABLED: 'dry_run' }), 'dry_run')
    assert.equal(getReferrerDmMode({ REFERRER_DM_ENABLED: 'true' }), 'live')
  })

  await test('parses "Referred by" in bullet, bold and table cards', () => {
    assert.equal(parseReferredBy(BRANDY_CARD.description), 'Jaron Rubenstein (shared info about community in our PEF WhatsApp)')
    assert.equal(parseReferredBy('**Referred by:** Tyler Rhorick'), 'Tyler Rhorick')
    assert.equal(parseReferredBy(JARON_CARD.description), '—')
    assert.equal(parseReferredBy('**Source:** referred by Jaron Rubenstein in Slack, 2026-08-26.'), null)
  })

  await test('keeps only one full name from the referrer line', () => {
    assert.equal(cleanReferrerName('Jaron Rubenstein, her Fractional CTO on Moxx'), 'Jaron Rubenstein')
    assert.equal(cleanReferrerName('Yoni Trotzky (Aiptimise), intro email Tue Oct 6. Met at a pitch.'), 'Yoni Trotzky')
    assert.equal(cleanReferrerName('Mujtaba Raza, intro email Wed Sep 30'), 'Mujtaba Raza')
    assert.equal(cleanReferrerName('[Tyler Rhorick](https://linear.app/x/CRM-1)'), 'Tyler Rhorick')
    assert.equal(cleanReferrerName('John Q. Public'), 'John Q. Public')
    assert.equal(cleanReferrerName('Your linkedin post :)'), null)
    assert.equal(cleanReferrerName('—'), null)
    assert.equal(cleanReferrerName('Jaron'), null)
    assert.equal(cleanReferrerName('Ana Ruiz and Luis Gil'), null)
  })

  await test('reads emails and Slack IDs from both card formats', () => {
    assert.deepEqual(parseEmails(JARON_CARD.description), ['jaron@rubensteinventures.com'])
    assert.deepEqual(parseSlackIds(JARON_CARD.description), ['U0AUJ54MPUG'])
    assert.deepEqual(parseSlackIds('* Email: [h@x.com](<mailto:h@x.com>) (Slack account, ID U0C7MTP3QA3)'), ['U0C7MTP3QA3'])
  })

  await test('copy follows Brian\'s wording, no em dashes', () => {
    const dm = buildReferrerDm('Jaron', 'Brandy Test', 'C0INTRO123')
    assert.equal(dm, 'Hi Jaron, a heads up: Brandy Test, who you referred, just joined The New Builder Slack. ' +
      'We like the person who referred someone to post the intro in <#C0INTRO123>. Would you mind doing that when you get a chance?')
    const comment = buildCrmComment('Jaron Rubenstein', new Date('2026-10-13T15:00:00Z'))
    assert.equal(comment, '* Joined TNB Slack Tue Oct 13, 2026.\n* Builder Bot DM sent to Jaron Rubenstein asking for the intro in #introduce-yourself (TNB-633).')
    assert.ok(!dm.includes('—') && !comment.includes('—'))
  })

  // --- the flow ----------------------------------------------------------------

  await test('off: no lookups at all', async () => {
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, BRANDY_CARD] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, { ...live, mode: 'off' })
    assert.equal(r.status, 'off')
    assert.equal(w.calls.getUser, 0)
    assert.equal(w.sent.length, 0)
  })

  await test('live: DMs the referrer once and comments on the CRM card', async () => {
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, BRANDY_CARD] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(r.status, 'sent', JSON.stringify(r))
    assert.equal(r.card, 'CRM-300')
    assert.equal(r.matchedBy, 'email')
    assert.equal(r.referrerMatchedBy, 'crm_slack_id:CRM-27')
    assert.deepEqual(w.sent, [{ to: 'U0AUJ54MPUG', text: buildReferrerDm('Jaron', 'Brandy Test', 'C0INTRO123') }])
    assert.equal(w.comments.length, 1)
    assert.equal(w.comments[0].card, 'CRM-300')
    const again = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(again.reason, 'already_sent')
    assert.equal(w.sent.length, 1)
  })

  await test('dry_run: full lookup, nothing sent, nothing written, nothing claimed', async () => {
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, BRANDY_CARD] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, { ...live, mode: 'dry_run' })
    assert.equal(r.status, 'dry_run')
    assert.ok(r.text?.startsWith('Hi Jaron,'))
    assert.equal(w.sent.length, 0)
    assert.equal(w.comments.length, 0)
    assert.equal(w.claimed.size, 0)
  })

  await test('pending invite is not a join', async () => {
    const pending = user('U0NEW00001', 'Brandy Test', { is_invited_user: true }, 'brandy@example.com')
    const w = makeDeps({ users: [jaron, pending], cards: [JARON_CARD, BRANDY_CARD] })
    const r = await handleConfirmedJoin(pending.id, w.deps, live)
    assert.equal(r.reason, 'joiner_invite_pending')
    assert.equal(w.sent.length, 0)
  })

  await test('referrer not in Slack: Brian introduces, bot does nothing', async () => {
    const noJaronCard = card('CRM-300', 'Brandy Test', BRANDY_CARD.description)
    const w = makeDeps({ users: [brandy], cards: [noJaronCard] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(r.reason, 'referrer_not_in_slack')
    assert.equal(w.sent.length, 0)
    assert.equal(w.comments.length, 0)
  })

  await test('referrer with a pending invite or deactivated is not active', async () => {
    for (const extra of [{ is_invited_user: true }, { deleted: true }, { is_restricted: true }]) {
      const ref = user('U0AUJ54MPUG', 'Jaron Rubenstein', extra)
      const w = makeDeps({ users: [ref, brandy], cards: [JARON_CARD, BRANDY_CARD] })
      const r = await handleConfirmedJoin(brandy.id, w.deps, live)
      assert.equal(r.reason, 'referrer_not_active_in_slack', JSON.stringify(extra))
      assert.equal(w.sent.length, 0)
    }
  })

  await test('referred by Brian or by a non-person: no DM', async () => {
    const brian = user('U0AQPP9T4QZ', 'Brian Hecht')
    for (const [line, reason] of [
      ['* Referred by: Brian Hecht', 'referrer_is_brian'],
      ['* Referred by: Your linkedin post :)', 'referred_by_not_a_name'],
      ['* Link: (none)', 'no_referred_by'],
    ]) {
      const c = card('CRM-300', 'Brandy Test', `* Email: [brandy@example.com](<mailto:brandy@example.com>)\n${line}`)
      const w = makeDeps({ users: [brian, brandy], cards: [c] })
      const r = await handleConfirmedJoin(brandy.id, w.deps, live)
      assert.equal(r.reason, reason)
      assert.equal(w.sent.length, 0)
    }
  })

  await test('referrer ID in REFERRER_DM_SKIP_IDS: no DM', async () => {
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, BRANDY_CARD] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, { ...live, skipReferrerIds: ['U0AUJ54MPUG'] })
    assert.equal(r.reason, 'referrer_in_skip_list')
    assert.equal(w.sent.length, 0)
  })

  await test('card already at 5. Introduced: no DM', async () => {
    const c = card('CRM-300', 'Brandy Test', BRANDY_CARD.description, '5. Introduced')
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, c] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(r.reason, 'already_introduced_or_closed')
    assert.equal(w.sent.length, 0)
  })

  await test('two CRM cards with the same email: no DM', async () => {
    const dup = card('CRM-301', 'Brandy T', BRANDY_CARD.description)
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, BRANDY_CARD, dup] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(r.reason, 'ambiguous_crm_card')
    assert.equal(w.sent.length, 0)
  })

  await test('no email scope: falls back to the exact card title', async () => {
    const noEmail = user('U0NEW00001', 'Brandy Test')
    const w = makeDeps({ users: [jaron, noEmail], cards: [JARON_CARD, BRANDY_CARD] })
    const r = await handleConfirmedJoin(noEmail.id, w.deps, live)
    assert.equal(r.status, 'sent')
    assert.equal(r.matchedBy, 'name')
  })

  await test('referrer without a CRM card: unique Slack full name', async () => {
    const tyler = user('U0TYLER001', 'Tyler Rhorick')
    const c = card('CRM-300', 'Brandy Test', '* Email: [brandy@example.com](<mailto:brandy@example.com>)\n* Referred by: Tyler Rhorick')
    const w = makeDeps({ users: [tyler, brandy], cards: [c] })
    const r = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(r.status, 'sent')
    assert.equal(r.referrerMatchedBy, 'slack_name')
    assert.equal(w.sent[0].to, 'U0TYLER001')
    const twin = user('U0TYLER002', 'Tyler Rhorick')
    const w2 = makeDeps({ users: [tyler, twin, brandy], cards: [c] })
    assert.equal((await handleConfirmedJoin(brandy.id, w2.deps, live)).reason, 'referrer_not_in_slack')
  })

  await test('failed DM releases the claim so a later event can retry', async () => {
    const w = makeDeps({ users: [jaron, brandy], cards: [JARON_CARD, BRANDY_CARD] })
    w.failDmNext()
    const r = await handleConfirmedJoin(brandy.id, w.deps, live)
    assert.equal(r.status, 'error')
    assert.equal(w.claimed.size, 0)
    assert.equal(w.comments.length, 0)
  })

  await test('bots, guests and deactivated joiners are ignored', async () => {
    for (const extra of [{ is_bot: true }, { is_restricted: true }, { deleted: true }]) {
      const j = user('U0NEW00001', 'Brandy Test', extra, 'brandy@example.com')
      const w = makeDeps({ users: [jaron, j], cards: [JARON_CARD, BRANDY_CARD] })
      const r = await handleConfirmedJoin(j.id, w.deps, live)
      assert.equal(r.reason, 'joiner_not_active_member', JSON.stringify(extra))
    }
  })

  console.log(`\n${passed} checks passed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
