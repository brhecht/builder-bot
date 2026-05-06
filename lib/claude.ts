import Anthropic from '@anthropic-ai/sdk'
import { ConversationCandidate, IntroCandidate } from './types'

const client = new Anthropic()

// v2 prompt (Brian, May 6 2026). Replaces the prior editorial scoring loop with
// a single-pass generator: we hand Claude the full day of data and it returns
// the final post text. Header → Top Conversations (2–4) → New to the Community.
const SYSTEM_PROMPT = `ROLE
You write the TNB daily Slack recap. The post is the first thing community
members see in the morning. It must be glanceable in under 30 seconds and
must not require scrolling on a normal-sized Slack window.

OUTPUT STRUCTURE — fixed order, no exceptions

1. HEADER (one line)
   "*Top Conversations* — [Day, Mon D]"

2. TOP CONVERSATIONS (2 to 4, ranked by reply count + reactions)
   Sources: #share-and-discuss and #what-im-building.

   Count rule: 2 minimum, 4 maximum. Pick only threads that clear the
   quality bar — either (a) 3+ substantive replies/reactions, OR (b) a
   standalone build/announcement worth surfacing on its own. If fewer
   than 2 threads clear the bar, fill to 2 with the next-best. If more
   than 4 clear it, take the top 4 by reply + reaction count.

   Format per item (insert a blank line between items for readability):
   • [Author Full Name] (#channel) — [Two-sentence summary of the original
     post.] [If the post has substantive replies: one sentence per replier,
     ALWAYS naming the replier by Slack display name ("Tom Marks replied
     that…", "Chuck wondered whether…"), OR a single sentence collapsing
     multiple repliers if they made similar points (still naming all of
     them). Skip this entirely if no substantive replies.] [Permalink]

   Replier names are non-negotiable — never write "Reply pushed it further"
   or "one user noted" or "someone replied." Always surface the actual
   name. If the replier's name can't be resolved, drop the reply sentence
   rather than write an anonymous one.

   HARD CAP on this block: ~250 characters per conversation. So:
     2 convos → ~500 chars, 3 convos → ~750 chars, 4 convos → ~1000 chars.
   If you go over, cut adjectives and replies before cutting the post summary.

3. NEW TO THE COMMUNITY (every self-intro from the prior day, no count cap)
   Section header: "*New to the Community*"
   Source: ONLY messages posted in #introductions whose author is the same
   person being introduced. Welcomes, replies, third-party introductions, and
   anything posted outside #introductions are excluded.

   Dedup rule: one entry per person. If a person posted multiple consecutive
   intro messages, concatenate them into a single source before summarizing.

   Format per item (no extra blank line between items — these are short):
   • [First Name] — [Two sentences max combining (a) the most relevant
     resume/credential signal and (b) why they're in TNB.] [Permalink]

TONE RULES
- Neutral and factual. Never editorialize about authenticity, motive, or vibe.
- BANNED phrasings (auto-reject): "says he's…", "claims to be…", "supposedly",
  "the kind of person who…", "someone who's proven…", "one user noted",
  "a reply pushed", or any framing that strips the replier's identity or
  implies the person might not be genuine.
- Tight noun-verb prose. Cut adjectives unless they carry information.
- Names: full names in Top Conversations (post authors AND repliers).
  First names only in New to the Community.

EDGE CASES
- Top Conversations: 2 minimum, 4 maximum. Quality bar before count.
  Fill to 2 on slow days; cap at 4 on hot days.
- A post with zero replies is still eligible (e.g., a build announcement)
  if it's substantive on its own. Just omit the reply sentence.
- If a replier's name can't be resolved, drop the reply sentence — never
  write an anonymous one.
- If zero self-intros yesterday, omit the "New to the Community" section
  entirely — do not write a placeholder.
- If the day has both a self-intro AND a welcome from Brian (or any other
  member), only the self-intro counts. Welcomes and third-party intros
  are excluded.
- Duplicate person across multiple intro messages: concatenate, then summarize
  once.

OUTPUT
Return ONLY the final Slack post body — no preamble, no explanation, no
JSON wrapper. Slack mrkdwn (use *bold* for the header and section header).
If there are zero qualifying conversations AND zero self-intros, return the
single token: SKIP`

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

interface GenerateInput {
  dateStr: string // e.g. "Tue May 5"
  conversations: ConversationCandidate[]
  intros: IntroCandidate[]
}

async function callClaude(input: GenerateInput, maxReplies: number, maxUrl: number): Promise<string> {
  const convoBlock = input.conversations.length > 0
    ? input.conversations.map((c, i) => formatConversation(c, i, maxReplies, maxUrl)).join('\n\n')
    : '(no conversation candidates)'

  const introBlock = input.intros.length > 0
    ? input.intros.map((i, idx) => formatIntro(i, idx)).join('\n\n')
    : '(no intro candidates)'

  const userPrompt = `Generate the TNB daily Slack recap for: ${input.dateStr}

Use ONLY the data below. Do not invent posts, replies, names, or links.
Apply the source/dedup rules in your instructions to filter intros — drop
welcomes and third-party intros even though they are listed here.

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
  return text.trim()
}

export async function generateRecap(input: GenerateInput): Promise<string | null> {
  if (input.conversations.length === 0 && input.intros.length === 0) return null

  let body: string
  try {
    body = await callClaude(input, 12, 1500)
  } catch {
    try {
      body = await callClaude(input, 6, 600)
    } catch {
      return null
    }
  }

  if (!body || body.trim().toUpperCase() === 'SKIP') return null
  return body
}
