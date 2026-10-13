// Slack Events endpoint for the TNB workspace (the Builder Bot app).
//
// One feature today: the referrer intro DM (TNB-633, lib/referrer-dm.ts).
// Bot events it uses (both need users:read):
//   team_join    a new member
//   user_change  an invited member signs in (only for users seen as pending)
//
// A real join only. Slack creates the user when the invite is sent, so a user
// with is_invited_user=true is not a join. If team_join arrives while the
// invite is pending, the route stores a pending marker and the DM waits for
// the user_change where the flag is gone. lib/referrer-dm.ts re-reads
// users.info and checks again before any DM.
//
// REFERRER_DM_ENABLED unset (the default) = this route acks and does nothing.
//
// Security: Slack signature with TNB_SLACK_SIGNING_SECRET (the Builder Bot
// app's signing secret, not the HC intake app's). No test bypass here; use
// GET /api/referrer-dm for read-only checks.
//
// Slack wants a 200 within 3s, so the work runs in waitUntil(). event_id is
// deduped in KV because Slack retries deliveries.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { claimTnbEvent, clearPendingJoin, isPendingJoin, markPendingJoin } from '@/lib/kv'
import { getReferrerDmMode, handleConfirmedJoin } from '@/lib/referrer-dm'
import { liveDeps, referrerDmConfig } from '@/lib/referrer-dm-live'
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

async function onTeamJoin(userId: string): Promise<void> {
  const result = await handleConfirmedJoin(userId, liveDeps(), referrerDmConfig())
  if (result.reason === 'joiner_invite_pending') {
    await markPendingJoin(userId)
    log(`team_join ${userId}: invite still pending, waiting for sign-in`)
  }
}

async function onUserChange(user: EventUser): Promise<void> {
  if (!user.id || user.is_invited_user) return
  if (!(await isPendingJoin(user.id))) return // most user_change events: profile edits
  const result = await handleConfirmedJoin(user.id, liveDeps(), referrerDmConfig())
  if (result.reason !== 'joiner_invite_pending') await clearPendingJoin(user.id)
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

  if (getReferrerDmMode() === 'off') {
    return NextResponse.json({ ok: true, ignored: 'referrer_dm_off' })
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
