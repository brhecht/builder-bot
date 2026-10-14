// Join mark (Linear TNB-674).
//
// When someone really joins the TNB Slack, Builder Bot marks their TNB CRM
// card: the TNB SLACK label goes on, and a card still before stage 4 moves to
// "4. Accepted". Brian's rule (Oct 9): 4. Accepted means the person accepted
// the Slack invite, and only that triggers an intro. A pending invite is not a
// join: Slack creates the account when the invite is sent.
//
// Nothing moves backwards. A card at 4 or later, a closed card, or a card in a
// status with no number (Deactivated account, In Review) keeps its status and
// only gets the label if it is missing. A card that already has the label and
// needs no move is left alone, with no comment.
//
// Flag: JOIN_MARK_ENABLED
//   unset or any other value -> "off": nothing runs
//   "dry_run"                -> every lookup runs, the planned change is logged, nothing is written
//   "true"                   -> live: label, status, comment on the card
//
// No I/O of its own: Slack and Linear come in as deps, so the flow runs
// against mocks in scripts/verify-join-mark.ts.

import { DateTime } from 'luxon'
import { CardLookupDeps, findJoinerCard, isActiveMember } from './referrer-dm'
import { CrmCard, SlackUser } from './types'

export type JoinMarkMode = 'off' | 'dry_run' | 'live'

export function getJoinMarkMode(env: Record<string, string | undefined> = process.env): JoinMarkMode {
  const v = (env.JOIN_MARK_ENABLED ?? '').trim().toLowerCase()
  if (v === 'true') return 'live'
  if (v === 'dry_run') return 'dry_run'
  return 'off'
}

export interface JoinMarkChange {
  addLabel?: string
  moveToState?: string
}

export interface JoinMarkDeps extends CardLookupDeps {
  getUser(userId: string): Promise<SlackUser | null>
  markCard(card: CrmCard, change: JoinMarkChange): Promise<void>
  commentOnCrmCard(card: CrmCard, body: string): Promise<void>
  log(msg: string): void
  now(): Date
}

export interface JoinMarkConfig {
  mode: JoinMarkMode
  crmTeamKey: string
  slackLabel: string      // "TNB SLACK"
  acceptedState: string   // "4. Accepted"
}

export type JoinMarkStatus = 'off' | 'skipped' | 'dry_run' | 'marked' | 'error'

export interface JoinMarkResult {
  status: JoinMarkStatus
  reason?: string
  joinerId: string
  card?: string
  matchedBy?: string
  change?: JoinMarkChange
  comment?: string
  commentError?: string
  error?: string
}

// "4. Accepted" -> 4. Statuses with no leading number -> null.
export function stageNumber(stateName: string): number | null {
  const m = stateName.match(/^\s*(\d+)\s*\./)
  return m ? Number(m[1]) : null
}

export function planJoinMark(card: CrmCard, cfg: Pick<JoinMarkConfig, 'slackLabel' | 'acceptedState'>): JoinMarkChange {
  const change: JoinMarkChange = {}
  const hasLabel = (card.labels ?? []).some((l) => l.trim().toLowerCase() === cfg.slackLabel.toLowerCase())
  if (!hasLabel) change.addLabel = cfg.slackLabel
  const closed = card.stateType === 'completed' || card.stateType === 'canceled'
  const n = stageNumber(card.stateName)
  const target = stageNumber(cfg.acceptedState)
  if (!closed && n !== null && target !== null && n < target) change.moveToState = cfg.acceptedState
  return change
}

// Register C: bullets, no opinion.
export function buildJoinMarkComment(change: JoinMarkChange, when: Date): string {
  const day = DateTime.fromJSDate(when).setZone('America/New_York').toFormat('ccc LLL d, yyyy')
  const lines = [`* Joined TNB Slack ${day} (Slack join event, invite accepted).`]
  if (change.addLabel) lines.push(`* Added ${change.addLabel}.`)
  if (change.moveToState) lines.push(`* Moved to ${change.moveToState}.`)
  lines.push('* Builder Bot join mark (TNB-674).')
  return lines.join('\n')
}

export async function handleJoinMark(joinerId: string, deps: JoinMarkDeps, cfg: JoinMarkConfig): Promise<JoinMarkResult> {
  const r: JoinMarkResult = { status: 'skipped', joinerId }
  const done = (status: JoinMarkStatus, reason?: string): JoinMarkResult => {
    r.status = status
    if (reason) r.reason = reason
    const parts = [r.change?.addLabel && `label="${r.change.addLabel}"`, r.change?.moveToState && `move="${r.change.moveToState}"`]
      .filter(Boolean).join(' ')
    deps.log(`join-mark ${status}${reason ? ` (${reason})` : ''} joiner=${joinerId}` +
      `${r.card ? ` card=${r.card}` : ''}${parts ? ` ${parts}` : ''}`)
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

  const change = planJoinMark(card, cfg)
  if (!change.addLabel && !change.moveToState) return done('skipped', 'already_marked')
  r.change = change
  r.comment = buildJoinMarkComment(change, deps.now())

  if (cfg.mode === 'dry_run') return done('dry_run')

  try {
    await deps.markCard(card, change)
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
    return done('error', 'mark_failed')
  }
  try {
    await deps.commentOnCrmCard(card, r.comment)
  } catch (err) {
    r.commentError = err instanceof Error ? err.message : String(err)
    deps.log(`join-mark comment failed card=${card.identifier}: ${r.commentError}`)
  }
  return done('marked')
}
