// Slack Events endpoint for Brain Intake.
//
// Slack → POST here for: url_verification (setup handshake), message.im
// (Nico DMs the bot), reaction_added (approver reacts on an approval message).
//
// Security: every non-test request must carry a valid Slack signature
// (HMAC-SHA256 with the signing secret over `v0:{ts}:{rawBody}`, 5-min replay
// window). The `?test=true&secret=<CRON_SECRET>` bypass is for curl-simulating
// events during development — it is HARD-DISABLED in production (VERCEL_ENV),
// because in test mode `ev.user` is attacker-controlled and would let anyone
// who learned the shared CRON_SECRET impersonate the approver. Never in prod.
//
// Slack requires a 200 within 3s; Claude takes longer — so we ack immediately
// and do the work in waitUntil(). Slack retries deliveries (0/+1min/+5min);
// claimEvent() dedupes by event_id (600s window covers all retries).

import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import {
  SUBMITTER_ID, APPROVER_ID, claimEvent, getMsgRef, reactionKind, logDebug, kvHealth,
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

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

function verifySignature(raw: string, ts: string | null, sig: string | null, secret: string): boolean {
  if (!ts || !sig) return false
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return false // malformed ts must fail closed (no replay bypass)
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false // 5-min replay window
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')
  return safeEqual(expected, sig)
}

export async function POST(req: NextRequest) {
  const raw = await req.text()

  let payload: { type?: string; challenge?: string; event_id?: string; event?: SlackEvent }
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Setup handshake — echo the challenge so the URL verifies in the Slack UI.
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  // Test bypass: dev/preview ONLY. Hard-off in production regardless of secret.
  const url = new URL(req.url)
  const isTest = process.env.VERCEL_ENV !== 'production' &&
    url.searchParams.get('test') === 'true' &&
    !!process.env.CRON_SECRET &&
    safeEqual(url.searchParams.get('secret') || '', process.env.CRON_SECRET)

  if (!isTest) {
    // Intake lives in the HC workspace via its own Slack app — its signing
    // secret is INTAKE_SLACK_SIGNING_SECRET (shared var as fallback).
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

// Health check — confirms the route is deployed AND its dependencies are live
// (KV is pinged, not just assumed — a dead KV used to fail totally silent).
export async function GET() {
  const kv = await kvHealth()
  const configured = {
    submitter: !!SUBMITTER_ID,
    signingSecret: !!(process.env.INTAKE_SLACK_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET),
    slackToken: !!(process.env.INTAKE_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN),
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    brainKey: !!process.env.BRAIN_INBOX_API_KEY,
    kv,
  }
  const ready = configured.signingSecret && configured.slackToken && configured.anthropicKey && configured.brainKey && kv
  return NextResponse.json({
    ok: true,
    feature: 'brain-intake',
    workspace: process.env.INTAKE_SLACK_BOT_TOKEN ? 'hc (own app)' : 'fallback (shared TNB token)',
    testModeEnabled: process.env.VERCEL_ENV !== 'production',
    trial: APPROVER_ID === SUBMITTER_ID,
    ready,
    configured,
  })
}
