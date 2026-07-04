// Brain Intake — Slack DM → Claude breakdown → approval → Brain Inbox.
//
// Flow: Nico pastes raw material (a Brian burst, meeting fragment, voice-note
// transcript, idea dump) into his DM with the intake bot. Claude decomposes it
// into structured work items (translate-brian distilled). The bot posts the
// breakdown back for Nico's review; on "ok" it sends a compressed English
// proposal to the approver (Brian — or Nico himself while INTAKE_APPROVER_ID
// is unset = TRIAL MODE). A ✅ reaction from the approver logs every item into
// Nico's Brain Inbox via its REST API. Nothing is ever logged without the
// approval reaction.
//
// WORKSPACE NOTE: this flow lives in the HUMBLE CONVICTION Slack workspace via
// its own Slack app ("Brain Intake", see INTAKE-SETUP.md), NOT in the TNB
// workspace where the recap crons run. That's why it uses its own credentials:
// INTAKE_SLACK_BOT_TOKEN / INTAKE_SLACK_SIGNING_SECRET (falling back to the
// shared SLACK_* vars only so the flow can be exercised before the HC app
// exists). Self-contained on purpose — the daily/weekly cron paths and
// lib/slack.ts are untouched.

import Anthropic from '@anthropic-ai/sdk'
import { Redis } from '@upstash/redis'

// --- Config -----------------------------------------------------------------

// Set in Vercel. Empty ⇒ unbound: the bot replies to any DM with the sender's
// user ID + setup instructions (self-serve binding, no ID hunting).
export const SUBMITTER_ID = process.env.INTAKE_SUBMITTER_ID || ''
// Unset ⇒ approvals go to the submitter = TRIAL MODE. Live: set to Brian's HC id.
export const APPROVER_ID = process.env.INTAKE_APPROVER_ID || SUBMITTER_ID
const IS_TRIAL = APPROVER_ID === SUBMITTER_ID

const BRAIN_URL = process.env.BRAIN_INBOX_URL || 'https://brain-inbox-six.vercel.app/api/brain'
// Valid Brain Inbox projectIds (brain.js HC_PROJECTS + observed live projects).
const PROJECT_LIST = ['humble-admin', 'email-campaigns', 'jarvis-app', 'hc-content', 'hc-revenue', 'unassigned']

const APPROVE_EMOJI = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', '+1', 'thumbsup'])
const REJECT_EMOJI = new Set(['x', 'negative_squared_cross_mark', '-1', 'thumbsdown', 'no_entry'])

// --- Types ------------------------------------------------------------------

export interface IntakeItem {
  title: string // Spanish, imperative, ≤80 chars (for Nico's Brain Inbox)
  title_en: string // English mirror (for the approver's message)
  description: string
  kind: 'task' | 'project' | 'sop' | 'nota'
  priority: 'urgent' | 'important' | 'whenever'
  projectId: string
  dueDate: string | null // YYYY-MM-DD
  tags: string[]
}

export interface IntakeBreakdown {
  resumen: string // Spanish, 1-2 lines
  resumen_en: string // English, 1-2 lines
  items: IntakeItem[]
  supuestos: string[]
  preguntas_para_brian: string[] // English, A/B one-tap format. Ideal: empty.
}

export type IntakeStatus = 'draft' | 'awaiting_approval' | 'approved' | 'rejected' | 'discarded'

export interface IntakeProposal {
  id: string
  submitterId: string
  raw: string
  breakdown: IntakeBreakdown
  status: IntakeStatus
  createdAt: number
  updatedAt: number
  approvalMsg?: { channel: string; ts: string }
  loggedShortIds?: string[]
}

// --- Intake-scoped Slack client ----------------------------------------------
// Uses the HC workspace app's token when configured; falls back to the shared
// TNB bot token so the pipeline can be tested before the HC app exists.

function intakeToken(): string {
  return process.env.INTAKE_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN || ''
}

async function slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${intakeToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`)
  return data
}

async function say(channel: string, text: string): Promise<void> {
  await slackApi('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false })
}

async function sayAndGetMsg(channelOrUserId: string, text: string): Promise<{ channel: string; ts: string }> {
  // Posting to a USER id resolves to a D… channel; the later reaction_added
  // event carries that D… id, so we must store what Slack resolved.
  const data = await slackApi('chat.postMessage', { channel: channelOrUserId, text, unfurl_links: false, unfurl_media: false })
  return { channel: data.channel as string, ts: data.ts as string }
}

async function editMsg(channel: string, ts: string, text: string): Promise<void> {
  await slackApi('chat.update', { channel, ts, text })
}

// --- KV state ---------------------------------------------------------------

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
})

const TTL = 60 * 60 * 24 * 14 // 14 days

// Last runtime error, readable without log access: redis GET intake_debug_last
export async function logDebug(where: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err)
  console.error(`intake ${where} failed:`, err)
  try {
    await redis.set('intake_debug_last', { where, msg, at: new Date().toISOString() }, { ex: 3600 })
  } catch { /* debug must never take the flow down */ }
}

async function getProposal(id: string): Promise<IntakeProposal | null> {
  return (await redis.get<IntakeProposal>(`intake_prop_${id}`)) ?? null
}
async function saveProposal(p: IntakeProposal): Promise<void> {
  p.updatedAt = Date.now()
  await redis.set(`intake_prop_${p.id}`, p, { ex: TTL })
}
async function getLatestDraftId(userId: string): Promise<string | null> {
  return (await redis.get<string>(`intake_latest_${userId}`)) ?? null
}
async function setLatestDraftId(userId: string, id: string | null): Promise<void> {
  if (id === null) await redis.del(`intake_latest_${userId}`)
  else await redis.set(`intake_latest_${userId}`, id, { ex: TTL })
}
async function setMsgRef(channel: string, ts: string, proposalId: string): Promise<void> {
  await redis.set(`intake_msg_${channel}_${ts}`, proposalId, { ex: TTL })
}
export async function getMsgRef(channel: string, ts: string): Promise<string | null> {
  return (await redis.get<string>(`intake_msg_${channel}_${ts}`)) ?? null
}
// Slack retries event deliveries — first writer wins, duplicates are dropped.
export async function claimEvent(eventId: string): Promise<boolean> {
  const res = await redis.set(`intake_evt_${eventId}`, 1, { nx: true, ex: 600 })
  return res === 'OK'
}

// --- Claude breakdown (translate-brian, distilled) ---------------------------

const INTAKE_SYSTEM = `ROLE
You decompose raw pasted material into structured work items for Nico's Brain Inbox.
Nico is the fractional COO executing for Brian Hecht (Humble Conviction / The New Builder).
The paste may be a Brian Slack burst, meeting-notes fragment, voice-note transcript, email, or Nico's own idea dump. Spanish, English, or mixed.

INTERPRETATION RULES (distilled from the translate-brian skill)
- Outcome-first: infer the result being asked for, not the literal words.
- Brian writes in fragmented bursts with typos; stitch fragments into one thought; typos carry no signal.
- Soft-worded lines from Brian ("maybe do X", "you could", "idk") attached to a concrete noun are REAL directives.
- Brian priors when scope is ambiguous: smallest effective version (anti-over-build), exact numbers never ranges, one KPI per project, baseline before variation.
- Glossary: "b things" = the B-Suite apps ecosystem · "B Things" = things-app, Brian's task manager · "Brain Inbox" = Nico's task system (where these items land) · TNB = "The New Builder" (Substack + Slack community + thenewbuilder.ai) · "Freddys" = paid Substack subscribers · "Brokeys" = free subscribers · "Eddy" = DEAD business (killed Apr 2026) — flag any Eddy mention in supuestos as needing verification.
- Never invent work that isn't implied. Fewer, sharper items beat many vague ones.

CLASSIFICATION (kind)
- task: single actionable step (≤1 work session). Imperative title, ≤80 chars.
- project: multi-step effort → ONE item titled "[Proyecto] …" whose description lists the first 3 concrete steps.
- sop: a repeatable process/rule being defined → title "[SOP] …".
- nota: non-actionable context worth keeping → include only if genuinely valuable.

FIELDS
- priority: urgent = explicit deadline / today / blocking someone · important = this week or Brian-facing · whenever = rest.
- dueDate: "YYYY-MM-DD" ONLY if the text implies a date. Resolve relative dates ("mañana", "Friday") against TODAY given in the input, timezone America/Bogota. Else null.
- projectId: one of {PROJECTS}. Use "unassigned" unless clearly one of the others.
- tags: 1-3 lowercase keywords (e.g. "tnb", "reddit", "content").
- title/description/resumen in Spanish (they are for Nico). title_en/resumen_en in English (for Brian's approval message).
- supuestos: assumptions you made that Nico should sanity-check (Spanish).
- preguntas_para_brian: ONLY decisions that exist solely in Brian's head, in English, each a one-tap A/B with a marked recommendation ("A or B? I'd do A because…"). An empty array is the ideal outcome.

OUTPUT — return ONLY this JSON, no preamble, no code fence:
{"resumen":"","resumen_en":"","items":[{"title":"","title_en":"","description":"","kind":"task","priority":"whenever","projectId":"unassigned","dueDate":null,"tags":[]}],"supuestos":[],"preguntas_para_brian":[]}`
  .replace('{PROJECTS}', PROJECT_LIST.join(', '))

function todayBogota(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
}

function sanitizeBreakdown(b: IntakeBreakdown): IntakeBreakdown | null {
  if (!b || !Array.isArray(b.items) || b.items.length === 0) return null
  const kinds = new Set(['task', 'project', 'sop', 'nota'])
  const prios = new Set(['urgent', 'important', 'whenever'])
  return {
    resumen: String(b.resumen || '').slice(0, 400),
    resumen_en: String(b.resumen_en || b.resumen || '').slice(0, 400),
    items: b.items.slice(0, 15).map((i) => ({
      title: String(i.title || '').slice(0, 120),
      title_en: String(i.title_en || i.title || '').slice(0, 120),
      description: String(i.description || ''),
      kind: kinds.has(i.kind) ? i.kind : 'task',
      priority: prios.has(i.priority) ? i.priority : 'whenever',
      projectId: PROJECT_LIST.includes(i.projectId) ? i.projectId : 'unassigned',
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(i.dueDate || '') ? i.dueDate : null,
      tags: (Array.isArray(i.tags) ? i.tags : []).slice(0, 3).map((t) => String(t).toLowerCase()),
    })).filter((i) => i.title),
    supuestos: (Array.isArray(b.supuestos) ? b.supuestos : []).slice(0, 8).map(String),
    preguntas_para_brian: (Array.isArray(b.preguntas_para_brian) ? b.preguntas_para_brian : []).slice(0, 4).map(String),
  }
}

export async function generateBreakdown(
  raw: string,
  edit?: { prev: IntakeBreakdown; note: string }
): Promise<IntakeBreakdown | null> {
  let user = `TODAY: ${todayBogota()}\n\nRAW PASTE:\n"""\n${raw}\n"""`
  if (edit) {
    user += `\n\nPREVIOUS BREAKDOWN (JSON):\n${JSON.stringify(edit.prev)}\n\nNICO'S EDIT NOTE (apply it and return the FULL corrected JSON):\n${edit.note}`
  }
  try {
    const anthropic = new Anthropic() // per-call: never break module load if key is absent
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: INTAKE_SYSTEM,
      messages: [{ role: 'user', content: user }],
    })
    const text = resp.content[0].type === 'text' ? resp.content[0].text : ''
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    return sanitizeBreakdown(JSON.parse(jsonText) as IntakeBreakdown)
  } catch (err) {
    await logDebug('breakdown', err)
    return null
  }
}

// --- Message assembly (deterministic — the LLM never writes these) -----------

const PRIO_ICON: Record<string, string> = { urgent: '🔴', important: '🟡', whenever: '⚪' }

function formatDraft(p: IntakeProposal): string {
  const b = p.breakdown
  const lines: string[] = [`🧠 *Desmenuce* \`${p.id}\``, `_${b.resumen}_`, '', `*Items (${b.items.length}):*`]
  b.items.forEach((i, n) => {
    const extras = [i.projectId !== 'unassigned' ? i.projectId : '', i.dueDate ? `📅 ${i.dueDate}` : '']
      .filter(Boolean).join(' · ')
    lines.push(`${n + 1}. ${PRIO_ICON[i.priority]} [${i.kind}] *${i.title}*${extras ? ` — ${extras}` : ''}`)
    if (i.description) lines.push(`    ${i.description.split('\n')[0].slice(0, 160)}`)
  })
  if (b.supuestos.length) lines.push('', `*Supuestos:* ${b.supuestos.map((s) => `\n• ${s}`).join('')}`)
  lines.push('', `*Para Brian:* ${b.preguntas_para_brian.length ? b.preguntas_para_brian.map((q) => `\n• ${q}`).join('') : 'ninguna — ejecutable directo'}`)
  lines.push('', 'Responde: `ok` → mandar a aprobación · `edit <nota>` → rehacer · `skip` → descartar')
  return lines.join('\n')
}

function formatApproval(p: IntakeProposal): string {
  const b = p.breakdown
  const lines: string[] = []
  if (IS_TRIAL) lines.push('🧪 *TRIAL — this message would go to Brian.*', '')
  lines.push(`📥 *Work-log approval* — from Nico's intake \`${p.id}\``, `_${b.resumen_en}_`, '')
  b.items.forEach((i, n) => {
    lines.push(`${n + 1}. ${PRIO_ICON[i.priority]} ${i.title_en}${i.dueDate ? ` (due ${i.dueDate})` : ''}`)
  })
  if (b.preguntas_para_brian.length) {
    lines.push('', '*Open choices:*')
    b.preguntas_para_brian.forEach((q) => lines.push(`• ${q}`))
  }
  lines.push('', '✅ = approve → these land in Nico\'s Brain Inbox · ❌ = reject · or reply with tweaks')
  return lines.join('\n')
}

// --- Brain Inbox ------------------------------------------------------------

async function postToBrain(item: IntakeItem, proposalId: string): Promise<{ ok: boolean; shortId?: string; error?: string }> {
  const key = process.env.BRAIN_INBOX_API_KEY
  if (!key) return { ok: false, error: 'BRAIN_INBOX_API_KEY not configured' }
  try {
    const res = await fetch(BRAIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        cmd: 'add',
        title: item.title,
        description: `${item.description}\n\n— via brain-intake \`${proposalId}\` (aprobado${IS_TRIAL ? ' en trial' : ' por Brian'})`,
        priority: item.priority,
        projectId: item.projectId,
        dueDate: item.dueDate,
        tags: [...item.tags, 'brain-intake', item.kind].filter((t, i, a) => a.indexOf(t) === i),
        platformTags: ['Slack'],
      }),
    })
    const data = (await res.json()) as { error?: string; data?: { shortId?: string } }
    if (data.error) return { ok: false, error: data.error }
    return { ok: true, shortId: data.data?.shortId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// --- Flow handlers (called from the events route) -----------------------------

function newId(): string {
  return `bi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// Self-serve binding: DM from an unbound/unexpected user → tell them their ID.
export async function handleUnbound(channel: string, userId: string): Promise<void> {
  await say(channel, SUBMITTER_ID
    ? `Este intake está configurado para otro usuario. Tu Slack user ID: \`${userId}\` — si eres Nico en un workspace nuevo, actualiza \`INTAKE_SUBMITTER_ID\` en Vercel (builder-bot) y redeploya.`
    : `⚙️ Intake sin configurar. Tu Slack user ID es \`${userId}\` — ponlo como \`INTAKE_SUBMITTER_ID\` en Vercel (builder-bot → Settings → Environment Variables) y redeploya. Después pégame material y arranco.`)
}

export async function handleNewPaste(channel: string, text: string): Promise<void> {
  if (text.trim().length < 15) {
    await say(channel, 'Pégame algo con más carne (mensaje de Brian, notas, transcript…) y lo desmenuzo en items para Brain Inbox. `help` para ver comandos.')
    return
  }
  const breakdown = await generateBreakdown(text)
  if (!breakdown) {
    await say(channel, '⚠️ No pude estructurar eso (fallo del modelo/parser). Reintenta o reformula el paste.')
    return
  }
  const p: IntakeProposal = {
    id: newId(), submitterId: SUBMITTER_ID, raw: text.slice(0, 4000), breakdown,
    status: 'draft', createdAt: Date.now(), updatedAt: Date.now(),
  }
  await saveProposal(p)
  await setLatestDraftId(SUBMITTER_ID, p.id)
  await say(channel, formatDraft(p))
}

export async function handleOk(channel: string): Promise<void> {
  const id = await getLatestDraftId(SUBMITTER_ID)
  const p = id ? await getProposal(id) : null
  if (!p || p.status !== 'draft') {
    await say(channel, 'No hay ningún desmenuce en borrador. Pégame material primero.')
    return
  }
  const msg = await sayAndGetMsg(APPROVER_ID, formatApproval(p))
  p.status = 'awaiting_approval'
  p.approvalMsg = msg
  await saveProposal(p)
  await setMsgRef(msg.channel, msg.ts, p.id)
  await say(channel, `📨 Enviado a aprobación${IS_TRIAL ? ' (🧪 trial: te llegó a ti mismo)' : ' de Brian'} — \`${p.id}\`. Con su ✅ los items caen en Brain Inbox.`)
}

export async function handleEdit(channel: string, note: string): Promise<void> {
  const id = await getLatestDraftId(SUBMITTER_ID)
  const p = id ? await getProposal(id) : null
  if (!p || p.status !== 'draft') {
    await say(channel, 'No hay borrador que editar. Pégame material primero.')
    return
  }
  const breakdown = await generateBreakdown(p.raw, { prev: p.breakdown, note })
  if (!breakdown) {
    await say(channel, '⚠️ El edit falló (modelo/parser). El borrador anterior sigue vivo — reintenta.')
    return
  }
  p.breakdown = breakdown
  await saveProposal(p)
  await say(channel, formatDraft(p))
}

export async function handleSkip(channel: string): Promise<void> {
  const id = await getLatestDraftId(SUBMITTER_ID)
  const p = id ? await getProposal(id) : null
  if (p && p.status === 'draft') {
    p.status = 'discarded'
    await saveProposal(p)
  }
  await setLatestDraftId(SUBMITTER_ID, null)
  await say(channel, '🗑️ Borrador descartado.')
}

export async function handleStatus(channel: string): Promise<void> {
  const id = await getLatestDraftId(SUBMITTER_ID)
  const p = id ? await getProposal(id) : null
  if (!p) {
    await say(channel, 'Sin intake activo. Pégame material y arranco.')
    return
  }
  const labels: Record<IntakeStatus, string> = {
    draft: '📝 borrador — responde `ok`/`edit`/`skip`',
    awaiting_approval: `⏳ esperando ✅ de${IS_TRIAL ? ' ti (trial)' : ' Brian'}`,
    approved: `✅ aprobado — en Brain Inbox: ${(p.loggedShortIds || []).map((s) => `#${s}`).join(', ') || '—'}`,
    rejected: '❌ rechazado',
    discarded: '🗑️ descartado',
  }
  await say(channel, `\`${p.id}\` (${p.breakdown.items.length} items) → ${labels[p.status]}`)
}

export async function handleHelp(channel: string): Promise<void> {
  await say(channel, [
    '*Brain Intake* — pégame material crudo (burst de Brian, notas, transcript) y lo convierto en items estructurados.',
    '`ok` → mandar el borrador a aprobación · `edit <nota>` → rehacer con tu nota · `skip` → descartar · `status` → estado del último intake',
    `Aprobador actual: ${IS_TRIAL ? '🧪 TRIAL (tú mismo)' : '<@' + APPROVER_ID + '>'} — su ✅ en el mensaje de aprobación manda todo a Brain Inbox.`,
  ].join('\n'))
}

export async function finalizeApproval(proposalId: string, approve: boolean): Promise<void> {
  const p = await getProposal(proposalId)
  if (!p || p.status !== 'awaiting_approval') return // already handled or unknown
  if (!approve) {
    p.status = 'rejected'
    await saveProposal(p)
    if (p.approvalMsg) await editMsg(p.approvalMsg.channel, p.approvalMsg.ts, formatApproval(p) + '\n\n❌ *Rejected.*')
    await say(SUBMITTER_ID, `❌ \`${p.id}\` rechazado${IS_TRIAL ? ' (trial)' : ' por Brian'}. Ajusta y re-mándalo si aplica.`)
    await setLatestDraftId(SUBMITTER_ID, null)
    return
  }
  // Claim the approval transition BEFORE posting (double-reaction guard).
  p.status = 'approved'
  await saveProposal(p)
  const results: string[] = []
  const failures: string[] = []
  for (const item of p.breakdown.items) {
    const r = await postToBrain(item, p.id)
    if (r.ok && r.shortId) results.push(`#${r.shortId}`)
    else failures.push(`"${item.title}" (${r.error || 'sin id'})`)
  }
  p.loggedShortIds = results.map((r) => r.slice(1))
  await saveProposal(p)
  const outcome = [
    `✅ *Approved — ${results.length}/${p.breakdown.items.length} logged to Brain Inbox*${results.length ? `: ${results.join(', ')}` : ''}`,
    failures.length ? `⚠️ Failed: ${failures.join(' · ')}` : '',
  ].filter(Boolean).join('\n')
  if (p.approvalMsg) await editMsg(p.approvalMsg.channel, p.approvalMsg.ts, formatApproval(p) + '\n\n' + outcome)
  await say(SUBMITTER_ID, `${IS_TRIAL ? '🧪 ' : ''}✅ \`${p.id}\` aprobado — ${results.length}/${p.breakdown.items.length} tasks en Brain Inbox${results.length ? `: ${results.join(', ')}` : ''}${failures.length ? `\n⚠️ Fallaron: ${failures.join(' · ')}` : ''}`)
  await setLatestDraftId(SUBMITTER_ID, null)
}

export function reactionKind(emoji: string): 'approve' | 'reject' | null {
  if (APPROVE_EMOJI.has(emoji)) return 'approve'
  if (REJECT_EMOJI.has(emoji)) return 'reject'
  return null
}
