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
  HARD LENGTH BUDGET: 130 characters MAX (count them). Cut adjectives,
  qualifiers, and parentheticals to fit. Never use semicolons as periods.
  Never write run-on sentences with "while also", "alongside", or commas
  joining four ideas. Two clean short sentences.
  Don't open the summary by re-stating the author's name — they're already
  in the bullet header. Lead with the verb: "Argues that…", "Shipped a…",
  "Links a piece arguing…", not "Brian posted that…".
- replier_sentence: ONE short sentence. HARD LENGTH BUDGET: 80 characters MAX.
  Options:
   • "Tom Marks replied that …" (single replier)
   • "Tom Marks and Iris ten Teije noted …" (multiple repliers, similar points)
   • null (no substantive replies, OR replier name unresolved)
- NEVER write "one user noted", "a reply pushed", "someone replied",
  "Replies push the idea further", or any framing that strips the
  replier's identity. If the name field is "(name unresolved)" or empty,
  set replier_sentence to null.
- Permalink: use the candidate's permalink verbatim. Do not modify.

The downstream assembler caps each bullet at ~280 chars. If your summary +
replier blows past the budget, the assembler drops the replier sentence to
keep the bullet readable. So WRITE TIGHT FROM THE START — don't rely on
truncation, and never plan to overflow.

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
- summary = exactly two sentences with TWO PERIODS. HARD LENGTH BUDGET:
  220 characters MAX (count them). One sentence for the resume/credential
  signal (current role + most relevant career fact). One sentence for why
  they're in TNB (what they want to learn, build, or share).
  BANNED CONNECTORS: "while also", "while serving as", "alongside", "as well
  as", "in addition to". These produce run-ons. Use a period instead.
  BANNED: stacking 3+ items with commas inside a single sentence (e.g.
  "across tourism, youth development, and film, plus venture work and…").
  Pick the strongest one or two facts and cut the rest.
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

  const replyLines = replies.length > 0
    ? replies
        .map((r) => `  • ${r.user_name ? `${r.user_name}: ` : '(name unresolved) '}${r.text}`)
        .join('\n')
    : '  (none)'

  return `--- Conversation ${index + 1} ---
Channel: #${c.channel_name}
Author: ${c.user_name}
Reply count: ${c.reply_count}
Permalink: ${c.permalink}
Post: ${c.text}
${c.url_content ? `Linked URL content (truncated): ${c.url_content.slice(0, maxUrl)}` : '(no linked URL)'}
Replies (most substantive first, with replier display name):
${replyLines}`
}

function formatIntro(i: IntroCandidate, index: number): string {
  return `--- Intro ${index + 1} ---
Author display name: ${i.user_name}
Author user_id: ${i.user_id}
Permalink: ${i.permalink}
Message: ${i.raw_text}`
}

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
  return {
    conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
    intros: Array.isArray(parsed.intros) ? parsed.intros : [],
  }
}

function assemblePost(data: RecapData, dateStr: string): string {
  const lines: string[] = [`*Top Conversations* — ${dateStr}`]

  // Top Conversations: blank line between items. Soft cap ~280 chars per
  // bullet; assembler drops replier sentence to fit but never truncates
  // summary mid-sentence.
  const convoBullets: string[] = []
  for (const c of data.conversations) {
    const bullet = buildConversationBullet(c, 280)
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

  // Strategy: never truncate mid-sentence (those "…" cuts read as broken
  // text). If the bullet exceeds the cap with replier included, drop the
  // replier. If it still exceeds, return the full summary anyway — better
  // a slightly long bullet than a mangled one. The prompt is responsible
  // for keeping summaries <=130 chars; long bullets here mean the LLM
  // overshot and we accept it as a soft fail.
  const bulletWithReplier = `• *${c.author}* (#${channel}) — ${summary}${replier ? ' ' + replier : ''} ${c.permalink}`
  if (bulletWithReplier.length <= cap) return bulletWithReplier
  return `• *${c.author}* (#${channel}) — ${summary} ${c.permalink}`
}

function buildIntroBullet(i: IntroOut): string | null {
  if (!i.first_name || !i.summary) return null
  const summary = i.summary.trim()
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

  return assemblePost(data, input.dateStr)
}
