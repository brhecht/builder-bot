// Slack Events endpoint for Brain Intake.
//
// Slack → POST here for: url_verification (setup handshake), message.im
// (Nico DMs the bot), reaction_added (approver reacts on an approval message).
//
// Security: every non-test request must carry a valid Slack signature
// (HMAC-SHA256 with SLACK_SIGNING_SECRET over `v0:{ts}:{rawBody}`). The
// `?test=true&secret=CRON_SECRET` bypass mirrors the repo's existing test
// convention (commit bf42b2d) and lets us simulate events with curl before
// the Slack app is wired up.
//
// Slack requires a 200 within 3s; Claude takes longer — so we ack immediately
// and do the work in waitUntil(). Slack retries deliveries (x-slack-retry-num);
// claimEvent() dedupes by event_id so retries are no-ops.

import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import {
  SUBMITTER_ID, APPROVER_ID, claimEvent, getMsgRef, reactionKind, logDebug,
  handleNewPaste, handleOk, handleEdit, handleSkip, handleStatus, handleHelp, handleUnbound, finalizeApproval,
} from '@/lib/intake'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SlackEvent {
  type: string
  subtype?: string
  channel_type?: string
  channel?: string
  user?: string
  text?: string
  bot_id?: string
  reaction?: string
  item?: { type: string; channel: string; ts: string }
}

function verifySignature(raw: string, ts: string | null, sig: string | null, secret: string): boolean {
  if (!ts || !sig) return false
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false // replay guard
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
}

export async function POST(req: NextRequest) {
  const raw = await req.text()

  let payload: { type?: string; challenge?: string; event_id?: string; event?: SlackEvent }
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Setup handshake — echo the challenge. Harmless, and lets the URL verify
  // in the Slack UI even if env ordering isn't perfect yet.
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const url = new URL(req.url)
  const isTest = url.searchParams.get('test') === 'true' && !!process.env.CRON_SECRET &&
    url.searchParams.get('secret') === process.env.CRON_SECRET

  if (!isTest) {
    // The intake flow lives in the HC workspace via its own Slack app — its
    // signing secret is INTAKE_SLACK_SIGNING_SECRET (shared var as fallback).
    const secret = process.env.INTAKE_SLACK_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET
    if (!secret) return NextResponse.json({ error: 'INTAKE_SLACK_SIGNING_SECRET not configured' }, { status: 503 })
    const ok = verifySignature(raw, req.headers.get('x-slack-request-timestamp'), req.headers.get('x-slack-signature'), secret)
    if (!ok) return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }

  if (payload.type !== 'event_callback' || !payload.event) {
    return NextResponse.json({ ok: true, ignored: payload.type })
  }

  // Dedupe Slack's retry deliveries (skip in test mode so curls can repeat).
  if (!isTest && payload.event_id) {
    const first = await claimEvent(payload.event_id)
    if (!first) return NextResponse.json({ ok: true, duplicate: true })
  }

  const ev = payload.event

  // --- Nico DMs the bot -------------------------------------------------------
  if (ev.type === 'message' && ev.channel_type === 'im' && !ev.bot_id && !ev.subtype && ev.channel && ev.user) {
    const text = (ev.text || '').trim()
    const channel = ev.channel
    let job: Promise<void>
    if (!SUBMITTER_ID || ev.user !== SUBMITTER_ID) job = handleUnbound(channel, ev.user) // self-serve ID binding
    else if (/^(ok|ok manda|manda|go|send)$/i.test(text)) job = handleOk(channel)
    else if (/^edit\s+/i.test(text)) job = handleEdit(channel, text.replace(/^edit\s+/i, ''))
    else if (/^(skip|cancel|descarta|descartar)$/i.test(text)) job = handleSkip(channel)
    else if (/^(status|estado|pendiente)$/i.test(text)) job = handleStatus(channel)
    else if (/^(help|ayuda|\?)$/i.test(text)) job = handleHelp(channel)
    else job = handleNewPaste(channel, text)
    waitUntil(job.catch((err) => logDebug('message-job', err)))
    return NextResponse.json({ ok: true })
  }

  // --- Approver reacts on an approval message ---------------------------------
  if (ev.type === 'reaction_added' && ev.item?.type === 'message' && ev.user === APPROVER_ID && ev.reaction) {
    const kind = reactionKind(ev.reaction)
    if (kind) {
      const { channel, ts } = ev.item
      waitUntil(
        (async () => {
          const proposalId = await getMsgRef(channel, ts)
          if (proposalId) await finalizeApproval(proposalId, kind === 'approve')
        })().catch((err) => logDebug('approval-job', err))
      )
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true, ignored: ev.type })
}

// Health check — lets Nico (and Vercel) confirm the route is deployed.
export async function GET() {
  return NextResponse.json({
    ok: true,
    feature: 'brain-intake',
    workspace: process.env.INTAKE_SLACK_BOT_TOKEN ? 'hc (own app)' : 'fallback (shared TNB token)',
    trial: APPROVER_ID === SUBMITTER_ID,
    configured: {
      submitter: !!SUBMITTER_ID,
      signingSecret: !!(process.env.INTAKE_SLACK_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET),
      anthropicKey: !!process.env.ANTHROPIC_API_KEY,
      brainKey: !!process.env.BRAIN_INBOX_API_KEY,
    },
  })
}
