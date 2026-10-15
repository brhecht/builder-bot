// Slack Events endpoint for the TNB workspace (the Builder Bot app).
//
// Two features run on a real join, each behind its own flag:
//   join mark          TNB SLACK + 4. Accepted on the CRM card (TNB-674, lib/join-mark.ts)
//   referrer intro DM  the referrer posts the intro (TNB-633, lib/referrer-dm.ts)
// Bot events it uses (both need users:read):
//   team_join    a new member
//   user_change  an invited member signs in (only for users seen as pending)
//
// A real join only. Slack creates the user when the invite is sent, so a user
// with is_invited_user=true is not a join. If team_join arrives while the
// invite is pending, the route stores a pending marker and both features wait
// for the user_change where the flag is gone. A run where a feature failed
// keeps the same marker, so the next user_change retries it. Each feature
// re-reads users.info and checks again before any write.
//
// JOIN_MARK_ENABLED and REFERRER_DM_ENABLED both unset (the default) = this
// route acks and does nothing.
//
// Security: Slack signature with TNB_SLACK_SIGNING_SECRET (the Builder Bot
// app's signing secret, not the HC intake app's). No test bypass here; use
// GET /api/referrer-dm for read-only checks.
//
// Slack wants a 200 within 3s, so the work runs in waitUntil(). event_id is
// deduped in KV because Slack retries deliveries.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getJoinMarkMode, handleJoinMark } from '@/lib/join-mark'
import { claimTnbEvent, clearPendingJoin, isPendingJoin, markPendingJoin } from '@/lib/kv'
import { getReferrerDmMode, handleConfirmedJoin } from '@/lib/referrer-dm'
import { joinMarkConfig, joinMarkLiveDeps, liveDeps, referrerDmConfig } from '@/lib/referrer-dm-live'
import { verifySlackSignature } from '@/lib/slack-signature'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface EventUser {
  id?: string
  is_invited_user?: boolean
}

interface SlackEventPayload {
  type?: string
  challenge?: string
  event_id?: string
  event?: { type: string; user?: EventUser | string }
}

function log(msg: string) {
  console.log(`[builder-bot] ${msg}`)
}

interface JoinRun {
  pending: boolean  // invite not accepted yet: wait for the sign-in
  failed: boolean   // a feature threw or returned an error: retry on the next user_change
}

// Runs every enabled feature for one user. The join mark runs first: the DM
// skips cards at 5 or later, and the mark never moves past 4. Each feature
// runs on its own, so a failure in one never stops the other. Both are safe
// to re-run: the mark skips a card that is already marked, the DM is claimed
// once per joiner.
async function runJoinFeatures(userId: string): Promise<JoinRun> {
  const run: JoinRun = { pending: false, failed: false }
  const one = async (name: string, fn: () => Promise<{ status: string; reason?: string }>) => {
    try {
      const r = await fn()
      if (r.reason === 'joiner_invite_pending') run.pending = true
      if (r.status === 'error') run.failed = true
    } catch (err) {
      run.failed = true
      log(`${name} ${userId} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await one('join-mark', () => handleJoinMark(userId, joinMarkLiveDeps(), joinMarkConfig()))
  await one('referrer-dm', () => handleConfirmedJoin(userId, liveDeps(), referrerDmConfig()))
  return run
}

async function onTeamJoin(userId: string): Promise<void> {
  const run = await runJoinFeatures(userId)
  if (run.pending || run.failed) {
    await markPendingJoin(userId)
    log(`team_join ${userId}: ${run.pending ? 'invite still pending, waiting for sign-in' : 'failed, retry on the next user_change'}`)
  }
}

async function onUserChange(user: EventUser): Promise<void> {
  if (!user.id || user.is_invited_user) return
  if (!(await isPendingJoin(user.id))) return // most user_change events: profile edits
  const run = await runJoinFeatures(user.id)
  if (!run.pending && !run.failed) await clearPendingJoin(user.id)
}

export async function POST(req: NextRequest) {
  const raw = await req.text()

  let payload: SlackEventPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Setup handshake: echo the challenge so the Request URL verifies in the
  // Slack app settings. Nothing else is read or written on this path.
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const secret = process.env.TNB_SLACK_SIGNING_SECRET
  if (!secret) return NextResponse.json({ error: 'TNB_SLACK_SIGNING_SECRET not configured' }, { status: 503 })
  const ok = verifySlackSignature(
    raw,
    req.headers.get('x-slack-request-timestamp'),
    req.headers.get('x-slack-signature'),
    secret,
  )
  if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 })

  if (payload.type !== 'event_callback' || !payload.event) {
    return NextResponse.json({ ok: true, ignored: payload.type })
  }

  if (getReferrerDmMode() === 'off' && getJoinMarkMode() === 'off') {
    return NextResponse.json({ ok: true, ignored: 'join_features_off' })
  }

  if (payload.event_id && !(await claimTnbEvent(payload.event_id))) {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  const ev = payload.event
  const user: EventUser = typeof ev.user === 'string' ? { id: ev.user } : (ev.user ?? {})

  if (ev.type === 'team_join' && user.id) {
    const id = user.id
    waitUntil(onTeamJoin(id).catch((err) => log(`team_join ${id} failed: ${err instanceof Error ? err.message : String(err)}`)))
    return NextResponse.json({ ok: true })
  }

  if (ev.type === 'user_change' && user.id) {
    waitUntil(onUserChange(user).catch((err) => log(`user_change ${user.id} failed: ${err instanceof Error ? err.message : String(err)}`)))
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true, ignored: ev.type })
}
