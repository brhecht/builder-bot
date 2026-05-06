import Anthropic from '@anthropic-ai/sdk'
import { ConversationCandidate, IntroCandidate } from './types'

const client = new Anthropic()

// v2 prompt (Brian, May 6 2026). The LLM returns STRUCTURED JSON with the data
// only — the route handler assembles the final post text deterministically so
// hard caps, date format, and spacing are not at the LLM's discretion.
const SYSTEM_PROMPT = `ROLE
You curate the data for the TNB daily Slack recap. The post is the first
thing community members see in the morning. It must be glanceable in under
30 seconds. You return STRUCTURED JSON. Another component assembles the
final post — do not return prose, headers, bullets, or markdown.

INPUT
You receive a list of conversation candidates (#share-and-discuss +
#what-im-building) and a list of intro candidates (#introductions). Each
candidate is annotated with author display name, reply count, and
permalink. Reply candidates carry the replier's display name when Slack
resolved it.

OUTPUT — return ONLY this JSON shape (no preamble, no code fence):
{
  "conversations": [
    {
      "author": "Full Name",
      "channel": "share-and-discuss",
      "summary": "Two-sentence summary of the original post. Concrete nouns and verbs.",
      "replier_sentence": "Full Name replied that … OR null if no substantive replies",
      "permalink": "https://slack.com/archives/…"
    }
  ],
  "intros": [
    {
      "first_name": "Jesse",
      "summary": "Two sentences max. Resume signal. Why in TNB.",
      "permalink": "https://slack.com/archives/…"
    }
  ]
}

If there are zero qualifying conversations AND zero qualifying intros,
return: {"conversations": [], "intros": []}

TOP CONVERSATIONS RULES
- 2 minimum, 4 maximum. Quality bar before count. Pick threads that have
  3+ substantive replies/reactions OR are standalone build announcements
  worth surfacing on their own.
- Rank by reply count + reactions.
- Author = Slack display name verbatim from the input. Do not abbreviate.
- summary = exactly two sentences with two PERIODS. Concrete nouns and verbs.
  HARD MAX 160 characters. Brian's reference sample runs ~150 chars per
  summary (175 was the longest). Cut adjectives, qualifiers, and
  parentheticals to fit. If your draft exceeds 160 chars, rewrite it
  shorter — do not submit anything over 160.
  Never use semicolons as periods. Never write run-on sentences with
  "while also", "alongside", or commas joining four ideas. Two clean
  short sentences.
  Don't open the summary by re-stating the author's name — they're already
  in the bullet header. Lead with the verb: "Argues that…", "Shipped a…",
  "Links a piece arguing…", not "Brian posted that…".
- replier_sentence: ONE short sentence. HARD MAX 130 characters.
  Brian's reference replier sentences run ~125 chars. Do NOT submit
  anything over 130 chars.
  REQUIRED whenever the candidate has substantive replies AND at least one
  replier name is resolved (not "(name unresolved)" or empty).

  CRITICAL: Do NOT omit the replier_sentence to "save space" or "fit a cap".
  The downstream assembler handles all length capping — your only job is to
  return correct data. If summary + replier together would be long, write
  the replier sentence tighter, but ALWAYS include it. The assembler will
  drop it only if the bullet truly cannot fit; that is its decision, not
  yours. Returning null for replier_sentence when valid replies exist is a
  spec violation.
  Options:
   • "Tom Marks replied that …" (single replier)
   • "Tom Marks and Iris ten Teije noted …" (multiple repliers, similar points)
   • null ONLY if (a) zero substantive replies, OR (b) every replier name
     in the input is unresolved.
  Substantive = adds an idea, pushback, or new angle. Banter, "+1",
  emoji-only, or single-word "agreed" reactions are not substantive.
- NEVER write "one user noted", "a reply pushed", "someone replied",
  "Replies push the idea further", or any framing that strips the
  replier's identity. If the name field is "(name unresolved)" or empty,
  set replier_sentence to null.
- Permalink: use the candidate's permalink verbatim. Do not modify.

DIVISION OF RESPONSIBILITY: You return the data. The assembler formats the
bullet and drops the replier sentence if the bullet would exceed ~360
chars. The spec target is ~250 chars per conversation; with summary 160 +
replier 130 + permalink 65 + header 38 we land near 360 max.

INTRO RULES
- Source: ONLY #introductions messages whose AUTHOR display name is
  plausibly the same person being introduced (a self-intro). Welcomes
  and third-party introductions are EXCLUDED — even though they may
  appear in the candidate list.
- Identifying a welcome: phrases like "everyone, please welcome…",
  "@person — glad you're here", or where the message describes someone
  in third person while the author is a different name. When in doubt,
  drop it.
- No count cap on legitimate self-intros. If 8 people self-introduced
  yesterday, return all 8.
- Dedup: if the same author posted multiple intro messages, concatenate
  them and return ONE entry. The author's display name is the dedup key.
- first_name = author's first name only. Strip last name. Strip emojis.
- summary = exactly two sentences with TWO PERIODS. HARD MAX 180 characters.
  Brian's reference intros run ~130 chars per summary (140 max). One sentence for the resume/credential
  signal (current role + most relevant career fact). One sentence for why
  they're in TNB (what they want to learn, build, or share).
  PUNCTUATION RULES (strict):
   • Use periods between sentences. Never semicolons. ";" is banned —
     replace with ". " always.
   • Never use a semicolon to link two independent clauses. "Seeking BD
     roles; exploring AI tools." is wrong; rewrite as "Seeking BD roles.
     Exploring AI tools." or merge into one tight clause.
  BANNED CONNECTORS: "while also", "while serving as", "alongside", "as well
  as", "in addition to". These produce run-ons. Use a period instead.
  Comma-separated lists of up to 3 items inside a sentence are fine
  (Brian's own sample uses "across product design, compliance, and CRM at
  Moon"). What's NOT fine is chaining a 3-item list onto another clause
  with another conjunction (e.g. "...across X, Y, and Z, plus venture
  work and...").
  Sample tone: "CMO of Tire Agent, scaled it into a top online tire
  retailer. Now deploying AI across the marketing stack, workflows, and
  analytics." Two periods. Two clean sentences.
- Permalink: use the candidate's permalink verbatim.

TONE RULES (apply to summary and replier_sentence)
- Neutral and factual. Never editorialize about authenticity, motive,
  or vibe.
- BANNED phrasings (auto-reject): "says he's…", "claims to be…",
  "supposedly", "the kind of person who…", "someone who's proven…",
  "one user noted", "a reply pushed". Anything that strips the replier's
  identity or implies the person might not be genuine.
- Tight noun-verb prose. Cut adjectives unless they carry information.

EDGE CASES
- A post with zero replies is still eligible if it's substantive on its
  own (build announcement, framework drop, original argument). Just set
  replier_sentence to null.
- If zero self-intros, return "intros": [].
- If a self-intro AND a welcome both exist for the same person, count
  only the self-intro.
- Duplicate person across multiple intro messages: concatenate, summarize
  once, one entry.`

interface ConversationOut {
  author: string
  channel: string
  summary: string
  replier_sentence: string | null
  permalink: string
}

interface IntroOut {
  first_name: string
  summary: string
  permalink: string
}

interface RecapData {
  conversations: ConversationOut[]
  intros: IntroOut[]
}

interface GenerateInput {
  dateStr: string // e.g. "Tue May 6" — used VERBATIM in header
  conversations: ConversationCandidate[]
  intros: IntroCandidate[]
}

function formatConversation(c: ConversationCandidate, index: number, maxReplies = 12, maxUrl = 1500): string {
  const replies = [...c.replies]
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, maxReplies)

  const resolvedRepliers = Array.from(
    new Set(
      c.replies
        .map((r) => r.user_name?.trim())
        .filter((n): n is string => !!n && !n.toLowerCase().includes('unresolved'))
    )
  )

  const replyLines = replies.length > 0
    ? replies
        .map((r) => `  • ${r.user_name ? `${r.user_name}: ` : '(name unresolved) '}${r.text}`)
        .join('\n')
    : '  (none)'

  // Per-conversation hard instruction. The system prompt says replier_sentence
  // is required when valid replies exist, but the LLM still self-censors
  // periodically. Annotating each conversation directly closes that gap.
  const replierInstruction = resolvedRepliers.length > 0
    ? `\nINSTRUCTION FOR THIS CONVERSATION: ${resolvedRepliers.length} resolved replier name(s) — ${resolvedRepliers.join(', ')}. Your JSON output for THIS conversation MUST set "replier_sentence" to a non-null sentence naming ${resolvedRepliers.length === 1 ? 'this person' : 'these people'} (one sentence summarizing what they added). Returning null here is a hard violation.`
    : (c.reply_count > 0
        ? '\nINSTRUCTION FOR THIS CONVERSATION: replies exist but no display names were resolved by Slack — set replier_sentence to null per spec.'
        : '\nINSTRUCTION FOR THIS CONVERSATION: zero replies — set replier_sentence to null.')

  return `--- Conversation ${index + 1} ---
Channel: #${c.channel_name}
Author: ${c.user_name}
Reply count: ${c.reply_count}
Permalink: ${c.permalink}
Post: ${c.text}
${c.url_content ? `Linked URL content (truncated): ${c.url_content.slice(0, maxUrl)}` : '(no linked URL)'}
Replies (most substantive first, with replier display name):
${replyLines}${replierInstruction}`
}

function formatIntro(i: IntroCandidate, index: number): string {
  return `--- Intro ${index + 1} ---
Author display name: ${i.user_name}
Author user_id: ${i.user_id}
Permalink: ${i.permalink}
Message: ${i.raw_text}`
}

// Last raw LLM JSON, exposed for dry-run diagnostics
export let lastLLMOutput: RecapData | null = null

async function callClaude(input: GenerateInput, maxReplies: number, maxUrl: number): Promise<RecapData> {
  const convoBlock = input.conversations.length > 0
    ? input.conversations.map((c, i) => formatConversation(c, i, maxReplies, maxUrl)).join('\n\n')
    : '(no conversation candidates)'

  const introBlock = input.intros.length > 0
    ? input.intros.map((i, idx) => formatIntro(i, idx)).join('\n\n')
    : '(no intro candidates)'

  const userPrompt = `Date for context (do not echo back, the assembler handles the header): ${input.dateStr}

Apply your rules to the data below and return ONLY the JSON shape from your
instructions. No preamble, no markdown, no code fences.

=== CONVERSATION CANDIDATES (#share-and-discuss + #what-im-building) ===
${convoBlock}

=== INTRO CANDIDATES (#introductions, raw — apply self-intro filter) ===
${introBlock}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
  // Tolerate leading code fences or stray prose by extracting the first {...} block
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('no JSON object in Claude response')

  const parsed = JSON.parse(match[0]) as Partial<RecapData>
  const out: RecapData = {
    conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
    intros: Array.isArray(parsed.intros) ? parsed.intros : [],
  }
  lastLLMOutput = out
  return out
}

function assemblePost(data: RecapData, dateStr: string): string {
  const lines: string[] = [`*Top Conversations* — ${dateStr}`]

  // Top Conversations: blank line between items. Cap 360 chars per bullet
  // (Brian's spec target: ~250; sample varies 330-470 but spec/v2 fix
  // table both say ~250 explicitly). Cap pushes us toward the target while
  // accommodating content-rich content. Drops replier_sentence to fit.
  const convoBullets: string[] = []
  for (const c of data.conversations) {
    const bullet = buildConversationBullet(c, 360)
    if (bullet) convoBullets.push(bullet)
  }
  if (convoBullets.length > 0) {
    lines.push('') // blank line after header
    lines.push(convoBullets.join('\n\n')) // blank line between conversations
  }

  // New to the Community: NO blank line between items, tight stack.
  if (data.intros.length > 0) {
    lines.push('') // blank line before section header
    lines.push('*New to the Community*')
    for (const i of data.intros) {
      const bullet = buildIntroBullet(i)
      if (bullet) lines.push(bullet)
    }
  }

  return lines.join('\n')
}

function buildConversationBullet(c: ConversationOut, cap: number): string | null {
  if (!c.author || !c.channel || !c.summary || !c.permalink) return null
  const channel = c.channel.replace(/^#/, '')
  const summary = c.summary.trim()
  const replier = (c.replier_sentence ?? '').trim()

  // Author is PLAIN per Brian's spec ("use *bold* for the header and section
  // header" — only those, not authors). His sample shows plain author too.
  // Strategy: never truncate mid-sentence (those "…" cuts read as broken
  // text). If the bullet exceeds the cap with replier included, drop the
  // replier. If it still exceeds, return the full summary anyway.
  const bulletWithReplier = `• ${c.author} (#${channel}) — ${summary}${replier ? ' ' + replier : ''} ${c.permalink}`
  if (bulletWithReplier.length <= cap) return bulletWithReplier
  return `• ${c.author} (#${channel}) — ${summary} ${c.permalink}`
}

function buildIntroBullet(i: IntroOut): string | null {
  if (!i.first_name || !i.summary) return null
  // Defensive: replace a semicolon used as a sentence break with ". "
  // and capitalize the first letter of the next clause. The prompt bans
  // this but the LLM still slips occasionally. Also collapse double spaces.
  const summary = i.summary
    .trim()
    .replace(/;\s+([a-zA-Z])/g, (_match, c: string) => `. ${c.toUpperCase()}`)
    .replace(/\s{2,}/g, ' ')
  const link = i.permalink ? ` ${i.permalink}` : ''
  return `• ${i.first_name} — ${summary}${link}`
}

export async function generateRecap(input: GenerateInput): Promise<string | null> {
  if (input.conversations.length === 0 && input.intros.length === 0) return null

  let data: RecapData
  try {
    data = await callClaude(input, 12, 1500)
  } catch {
    try {
      data = await callClaude(input, 6, 600)
    } catch {
      return null
    }
  }

  if (data.conversations.length === 0 && data.intros.length === 0) return null

  console.log('[builder-bot] LLM raw output:', JSON.stringify(data, null, 2))

  // Deterministic fallback: if the LLM omitted replier_sentence on a convo
  // that has resolved replier names in the candidate input, fill it in from
  // the first substantive reply. Match candidate by permalink (preferred) or
  // author + channel (fallback if LLM altered the permalink).
  for (const c of data.conversations) {
    if (c.replier_sentence && c.replier_sentence.trim()) continue
    const candidate =
      input.conversations.find((cc) => cc.permalink === c.permalink) ??
      input.conversations.find((cc) => cc.user_name === c.author && cc.channel_name === c.channel.replace(/^#/, ''))
    if (!candidate) {
      console.log(`[builder-bot] fallback skip: no candidate match for ${c.author} permalink=${c.permalink}`)
      continue
    }
    const resolvedReplies = candidate.replies.filter(
      (r) => r.user_name && !r.user_name.toLowerCase().includes('unresolved')
    )
    if (resolvedReplies.length === 0) {
      console.log(`[builder-bot] fallback skip: ${candidate.user_name} has 0 resolved replies`)
      continue
    }
    const fullName = resolvedReplies[0].user_name!.trim()
    const snippet = resolvedReplies[0].text
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90)
      .replace(/\s+\S*$/, '')
      .replace(/[.!?]+$/, '')
    c.replier_sentence = `${fullName} replied that ${snippet}.`
    console.log(`[builder-bot] fallback applied for ${c.author}: ${c.replier_sentence}`)
  }

  return assemblePost(data, input.dateStr)
}
