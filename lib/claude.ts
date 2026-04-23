import Anthropic from '@anthropic-ai/sdk'
import { ConversationCandidate, IntroCandidate, PendingIntro, ScoredItem } from './types'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are the editorial voice of The New Builder — a community of founders and builders who use AI seriously in their work. These are not hobbyists. They are people building real products and companies.

Your job is to select and summarize the most substantive, interesting activity from the past period in The New Builder Slack. You are curating, not logging. You have editorial judgment. Use it.

A good item: someone shipped something specific, shared an insight that challenges an assumption, or sparked a conversation where people actually disagreed or built on each other's ideas.

A bad item: banter, generic enthusiasm, vague questions with no follow-up, or link drops with no context or reaction.

When writing summaries: be specific. Name what the person built or said. Name what made it interesting. Write to make someone curious enough to click. No hype. No filler. Max 2-3 lines per item.

For new member intros: draw from both the referrer's introduction and the member's own words. Make them sound like someone worth knowing.`

function formatCandidate(c: ConversationCandidate, index: number, maxReplies = 10, maxUrl = 2000): string {
  const replies = [...c.replies]
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, maxReplies)

  return `--- Item ${index + 1} ---
Channel: #${c.channel_name}
Posted by: ${c.user_name}
Text: ${c.text}
Total replies: ${c.reply_count}
${c.url_content ? `URL content: ${c.url_content.slice(0, maxUrl)}` : '(no URL)'}
Replies (most substantive first):
${replies.length > 0 ? replies.map((r) => `  • ${r.text}`).join('\n') : '  (none)'}`
}

async function callClaude(candidates: ConversationCandidate[], maxReplies: number, maxUrl: number): Promise<ScoredItem[]> {
  const formatted = candidates.map((c, i) => formatCandidate(c, i, maxReplies, maxUrl)).join('\n\n')

  const userPrompt = `Evaluate each of the following ${candidates.length} Slack thread(s). For each:
1. Score "Include" or "Skip"
2. One-line reason
3. If Include: write the final 2-3 line summary for the daily recap (be specific, no hype)

Respond ONLY with a JSON array:
[{"item": 1, "decision": "Include", "reason": "...", "summary": "..."}, ...]

Items:
${formatted}`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('no JSON array in Claude response')

  const results = JSON.parse(match[0]) as Array<{
    item: number
    decision: string
    reason: string
    summary?: string
  }>

  return candidates.map((c, i) => {
    const r = results.find((x) => x.item === i + 1)
    return {
      candidate: c,
      decision: r?.decision === 'Include' ? 'Include' : 'Skip',
      summary: r?.summary,
    }
  })
}

export async function scoreAndSummarize(candidates: ConversationCandidate[]): Promise<ScoredItem[]> {
  if (candidates.length === 0) return []

  try {
    return await callClaude(candidates, 10, 2000)
  } catch {
    // Retry with truncated input
    try {
      return await callClaude(candidates, 5, 1000)
    } catch {
      // Total failure — skip everything
      return candidates.map((c) => ({ candidate: c, decision: 'Skip' as const }))
    }
  }
}

export async function processIntro(intro: IntroCandidate, date: string): Promise<PendingIntro> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Extract the new member's name and write a 1-2 line intro summary from this #introduce-yourself message. Draw from the referrer's words and the member's own description. Make them sound like someone worth knowing.

Return ONLY JSON: {"name": "...", "summary": "..."}

Message:
${intro.raw_text}`,
    }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { name: string; summary: string }
      return { name: parsed.name, summary: parsed.summary, collected_date: date }
    } catch { /* fall through */ }
  }

  // Fallback: use first 200 chars of the message
  return {
    name: 'New Member',
    summary: intro.raw_text.slice(0, 200),
    collected_date: date,
  }
}
