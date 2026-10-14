// Referrer intro DM (Linear TNB-633, approved by Brian Oct 13 2026).
//
// When a referred member really joins the TNB Slack, Builder Bot DMs the
// person who referred them and asks them to post the intro in
// #introduce-yourself. Brian's rules (priority agenda, Oct 9):
//   - The referrer posts the intro, not Brian.
//   - Only if the referrer is active in the TNB Slack. Otherwise Brian
//     introduces the person himself and the bot does nothing.
//   - A pending invite is not a join. Slack creates the account when the
//     invite is sent; only a signed-in user counts.
// Anything missing or ambiguous (no CRM card, two cards, a "Referred by" that
// is not a name, a referrer who is not in Slack) ends in a log line and no DM.
//
// Flag: REFERRER_DM_ENABLED
//   unset or any other value -> "off": nothing runs
//   "dry_run"                -> every lookup runs, the DM text is logged, nothing is sent or written
//   "true"                   -> live: DM the referrer, comment on the CRM card
//
// This module has no I/O of its own. Slack, Linear and KV come in as deps so
// the whole flow runs against mocks in scripts/verify-referrer-dm.ts.

import { DateTime } from 'luxon'
import { CrmCard, SlackUser } from './types'

export type ReferrerDmMode = 'off' | 'dry_run' | 'live'

export function getReferrerDmMode(env: Record<string, string | undefined> = process.env): ReferrerDmMode {
  const v = (env.REFERRER_DM_ENABLED ?? '').trim().toLowerCase()
  if (v === 'true') return 'live'
  if (v === 'dry_run') return 'dry_run'
  return 'off'
}

export interface ReferrerDmDeps {
  getUser(userId: string): Promise<SlackUser | null>
  lookupUserByEmail(email: string): Promise<SlackUser | null>
  listUsers(): Promise<SlackUser[]>
  // All three search the TNB CRM team only.
  findCrmCardsByText(text: string): Promise<CrmCard[]>
  findCrmCardsByTitle(title: string): Promise<CrmCard[]>
  sendDm(slackUserId: string, text: string): Promise<void>
  commentOnCrmCard(card: CrmCard, body: string): Promise<void>
  // One DM per joiner, ever. claim is atomic (KV SET NX).
  claimDm(joinerId: string): Promise<boolean>
  releaseDm(joinerId: string): Promise<void>
  log(msg: string): void
  now(): Date
}

export interface ReferrerDmConfig {
  mode: ReferrerDmMode
  crmTeamKey: string
  introChannelId?: string     // renders as a clickable #introduce-yourself
  skipReferrerIds: string[]   // Slack IDs that never get the DM (Brian)
}

export type ReferrerDmStatus = 'off' | 'skipped' | 'dry_run' | 'sent' | 'error'

export interface ReferrerDmResult {
  status: ReferrerDmStatus
  reason?: string
  joinerId: string
  joinerName?: string
  card?: string            // CRM identifier, e.g. CRM-231
  matchedBy?: string       // how the joiner's card was found
  referredByRaw?: string
  referrerName?: string
  referrerSlackId?: string
  referrerMatchedBy?: string
  text?: string
  comment?: string
  commentError?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Parsing the CRM card. Two formats live in TNB CRM today:
//   bullets:  "* Referred by: Jaron Rubenstein, her Fractional CTO on Moxx"
//   table:    "| Referred by | — |"
// ---------------------------------------------------------------------------

const SLACK_ID_RE = /\b[UW][A-Z0-9]{8,12}\b/g
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi

export function parseReferredBy(description: string): string | null {
  for (const line of description.split('\n')) {
    const m = line.match(/referred by\s*(?:\*\*)?\s*[:|]\s*(?:\*\*)?\s*(.*)$/i)
    if (!m) continue
    const value = m[1].replace(/\|\s*$/, '').trim()
    return value || null
  }
  return null
}

// "Yoni Trotzky (Aiptimise), intro email Tue Oct 6." -> "Yoni Trotzky".
// Returns null for anything that is not one person's full name: "—",
// "Your linkedin post :)", "Jaron", "Ana and Luis".
export function cleanReferrerName(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown links -> text
    .replace(/[`*_]/g, '')
    .replace(/^@/, '')
    .trim()
  if (/^(?:none|n\/a|unknown|[-–—]+)?$/i.test(s)) return null
  // Cut at the first "(", ",", ";", spaced dash, or a period that ends a
  // sentence (not the one after a middle initial like "John Q. Public").
  s = s.split(NAME_CUT_RE)[0].replace(/\s+/g, ' ').trim()
  if (/\s(?:and)\s|&|\//i.test(s)) return null
  return NAME_RE.test(s) ? s : null
}

// Built with the constructor: \p{..} and lookbehind need the "u" flag, and the
// tsconfig has no explicit target for regex literals to be checked against.
const NAME_CUT_RE = new RegExp('[(,;]|\\s[-–—]\\s|(?<!(?:^|\\s)\\p{Lu})\\.(?:\\s|$)', 'u')
const NAME_WORD = "\\p{Lu}[\\p{L}'’-]*"
const NAME_RE = new RegExp(`^${NAME_WORD}(?:\\s+(?:\\p{Lu}\\.|${NAME_WORD})){1,3}$`, 'u')

export function parseEmails(description: string): string[] {
  return Array.from(new Set((description.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())))
}

// Slack IDs on lines that talk about Slack ("Slack member ID | `U0AUJ54MPUG`",
// "(Slack account, ID U0C7MTP3QA3)"). Other IDs in the card are ignored.
export function parseSlackIds(description: string): string[] {
  const ids: string[] = []
  for (const line of description.split('\n')) {
    if (!/slack/i.test(line)) continue
    for (const id of line.match(SLACK_ID_RE) ?? []) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export function normalizeName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Signed in, not deactivated, not a bot, not a guest.
export function isActiveMember(u: SlackUser | null | undefined): boolean {
  return !!u && u.id !== 'USLACKBOT' && !u.deleted && !u.is_bot && !u.is_app_user &&
    !u.is_invited_user && !u.is_restricted && !u.is_ultra_restricted
}

// "5. Introduced" and later, or a closed card: the intro already happened or
// the person is out. The DM would be noise.
export function introStageReached(card: CrmCard): boolean {
  if (card.stateType === 'completed' || card.stateType === 'canceled') return true
  const n = card.stateName.match(/^\s*(\d+)\s*\./)
  return !!n && Number(n[1]) >= 5
}

export function slackFullName(u: SlackUser): string {
  return (u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || '').trim()
}

// ---------------------------------------------------------------------------
// Copy. The DM follows Brian's wording from the Oct 13 call; it does not
// pretend to be him. No em dashes in either text.
// ---------------------------------------------------------------------------

export function buildReferrerDm(referrerFirstName: string, joinerName: string, introChannelId?: string): string {
  const channel = introChannelId ? `<#${introChannelId}>` : '#introduce-yourself'
  return `Hi ${referrerFirstName}, a heads up: ${joinerName}, who you referred, just joined The New Builder Slack. ` +
    `We like the person who referred someone to post the intro in ${channel}. ` +
    'Would you mind doing that when you get a chance?'
}

// Register C: bullets, no opinion.
export function buildCrmComment(referrerName: string, when: Date): string {
  const day = DateTime.fromJSDate(when).setZone('America/New_York').toFormat('ccc LLL d, yyyy')
  return [
    `* Joined TNB Slack ${day}.`,
    `* Builder Bot DM sent to ${referrerName} asking for the intro in #introduce-yourself (TNB-633).`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export type CardMatch = { card: CrmCard; via: string } | { error: 'no_crm_card' | 'ambiguous_crm_card'; via?: string }
export type CardLookupDeps = Pick<ReferrerDmDeps, 'findCrmCardsByText' | 'findCrmCardsByTitle'>

// Joiner -> CRM card. In order: Slack ID written on the card, Slack email,
// exact full name as the card title. The first step that finds anything
// decides; two cards at that step means no DM. Shared with the join mark.
export async function findJoinerCard(joiner: SlackUser, deps: CardLookupDeps): Promise<CardMatch> {
  const byId = (await deps.findCrmCardsByText(joiner.id)).filter((c) => parseSlackIds(c.description).includes(joiner.id))
  if (byId.length === 1) return { card: byId[0], via: 'slack_id' }
  if (byId.length > 1) return { error: 'ambiguous_crm_card', via: 'slack_id' }

  const email = joiner.profile?.email?.toLowerCase()
  if (email) {
    const byEmail = (await deps.findCrmCardsByText(email)).filter((c) => parseEmails(c.description).includes(email))
    if (byEmail.length === 1) return { card: byEmail[0], via: 'email' }
    if (byEmail.length > 1) return { error: 'ambiguous_crm_card', via: 'email' }
  }

  const name = cleanReferrerName(slackFullName(joiner))
  if (name) {
    const byName = (await deps.findCrmCardsByTitle(name)).filter((c) => normalizeName(c.title) === normalizeName(name))
    if (byName.length === 1) return { card: byName[0], via: 'name' }
    if (byName.length > 1) return { error: 'ambiguous_crm_card', via: 'name' }
  }
  return { error: 'no_crm_card' }
}

// Referrer name -> Slack user. First the referrer's own CRM card (Slack ID on
// it, then its emails), then an exact, unique full-name match in Slack.
async function resolveReferrer(name: string, deps: ReferrerDmDeps): Promise<{ user: SlackUser; via: string } | null> {
  const cards = (await deps.findCrmCardsByTitle(name)).filter((c) => normalizeName(c.title) === normalizeName(name))
  if (cards.length === 1) {
    for (const id of parseSlackIds(cards[0].description)) {
      const u = await deps.getUser(id)
      if (u) return { user: u, via: `crm_slack_id:${cards[0].identifier}` }
    }
    for (const email of parseEmails(cards[0].description)) {
      const u = await deps.lookupUserByEmail(email)
      if (u) return { user: u, via: `crm_email:${cards[0].identifier}` }
    }
  }

  const target = normalizeName(name)
  const matches = (await deps.listUsers()).filter((u) =>
    !u.deleted && !u.is_bot &&
    [u.profile?.real_name, u.real_name, u.profile?.display_name]
      .some((n) => !!n && normalizeName(n) === target),
  )
  if (matches.length === 1) return { user: matches[0], via: 'slack_name' }
  return null
}

// ---------------------------------------------------------------------------
// The flow. Called once a join is confirmed by the events route, or by the
// dry-run check endpoint.
// ---------------------------------------------------------------------------

export async function handleConfirmedJoin(
  joinerId: string,
  deps: ReferrerDmDeps,
  cfg: ReferrerDmConfig,
): Promise<ReferrerDmResult> {
  const r: ReferrerDmResult = { status: 'skipped', joinerId }
  const done = (status: ReferrerDmStatus, reason?: string): ReferrerDmResult => {
    r.status = status
    if (reason) r.reason = reason
    deps.log(`referrer-dm ${status}${reason ? ` (${reason})` : ''} joiner=${joinerId}` +
      `${r.card ? ` card=${r.card}` : ''}${r.referrerName ? ` referrer="${r.referrerName}"` : ''}` +
      `${r.referrerSlackId ? ` referrer_id=${r.referrerSlackId}` : ''}${r.referredByRaw && !r.referrerName ? ` referred_by="${r.referredByRaw}"` : ''}`)
    return r
  }

  if (cfg.mode === 'off') return done('off')

  const joiner = await deps.getUser(joinerId)
  if (!joiner) return done('skipped', 'joiner_not_found')
  if (joiner.is_invited_user) return done('skipped', 'joiner_invite_pending')
  if (!isActiveMember(joiner)) return done('skipped', 'joiner_not_active_member')

  const match = await findJoinerCard(joiner, deps)
  if ('error' in match) return done('skipped', match.error)
  const card = match.card
  r.card = card.identifier
  r.matchedBy = match.via
  if (card.teamKey !== cfg.crmTeamKey) return done('skipped', 'card_outside_crm_team')
  if (introStageReached(card)) return done('skipped', 'already_introduced_or_closed')

  const raw = parseReferredBy(card.description)
  if (!raw) return done('skipped', 'no_referred_by')
  r.referredByRaw = raw
  const referrerName = cleanReferrerName(raw)
  if (!referrerName) return done('skipped', 'referred_by_not_a_name')
  r.referrerName = referrerName
  if (normalizeName(referrerName) === 'brian hecht') return done('skipped', 'referrer_is_brian')

  const ref = await resolveReferrer(referrerName, deps)
  if (!ref) return done('skipped', 'referrer_not_in_slack')
  r.referrerSlackId = ref.user.id
  r.referrerMatchedBy = ref.via
  if (ref.user.id === joiner.id) return done('skipped', 'self_referral')
  if (cfg.skipReferrerIds.includes(ref.user.id)) return done('skipped', 'referrer_in_skip_list')
  // Re-read the referrer: a users.list row or a stale CRM ID is not enough.
  const fresh = (await deps.getUser(ref.user.id)) ?? ref.user
  if (!isActiveMember(fresh)) return done('skipped', 'referrer_not_active_in_slack')

  const titleName = cleanReferrerName(card.title)
  r.joinerName = titleName ?? (slackFullName(joiner) || card.title)
  r.text = buildReferrerDm(referrerName.split(' ')[0], r.joinerName, cfg.introChannelId)
  r.comment = buildCrmComment(referrerName, deps.now())

  if (cfg.mode === 'dry_run') {
    deps.log(`referrer-dm dry_run text: ${r.text}`)
    return done('dry_run')
  }

  if (!(await deps.claimDm(joiner.id))) return done('skipped', 'already_sent')
  try {
    await deps.sendDm(ref.user.id, r.text)
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
    await deps.releaseDm(joiner.id).catch(() => undefined)
    return done('error', 'dm_failed')
  }
  try {
    await deps.commentOnCrmCard(card, r.comment)
  } catch (err) {
    // The DM went out; a missing comment is logged, never retried into a second DM.
    r.commentError = err instanceof Error ? err.message : String(err)
    deps.log(`referrer-dm comment failed card=${card.identifier}: ${r.commentError}`)
  }
  return done('sent')
}
