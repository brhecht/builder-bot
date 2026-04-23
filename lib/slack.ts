import { SlackMessage, SlackReply } from './types'

const SLACK_BASE = 'https://slack.com/api'

async function slackGet(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_BASE}/${method}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  })

  const data = (await res.json()) as Record<string, unknown>
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`)
  return data
}

async function slackPost(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`)
  return data
}

// Per-invocation user name cache
const userCache = new Map<string, string>()

export async function getUserName(userId: string): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!
  try {
    const data = await slackGet('users.info', { user: userId })
    const profile = (data.user as Record<string, Record<string, string>>)?.profile
    const name = profile?.display_name || profile?.real_name || userId
    userCache.set(userId, name)
    return name
  } catch {
    return userId
  }
}

export async function getChannelMessages(channelId: string, oldest: number): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  let cursor: string | undefined

  do {
    const params: Record<string, string> = {
      channel: channelId,
      oldest: oldest.toString(),
      limit: '200',
    }
    if (cursor) params.next_cursor = cursor

    let data: Record<string, unknown>
    try {
      data = await slackGet('conversations.history', params)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not_in_channel')) throw new Error('not_in_channel')
      throw err
    }

    const msgs = (data.messages as SlackMessage[]) ?? []
    // Filter to user messages only (skip join/leave/etc)
    const userMsgs = msgs.filter(
      (m) => !m.subtype || m.subtype === 'bot_message'
    )
    messages.push(...userMsgs)

    const meta = data.response_metadata as Record<string, string> | undefined
    cursor = meta?.next_cursor || undefined
  } while (cursor)

  return messages
}

export async function getThreadReplies(channelId: string, ts: string): Promise<SlackReply[]> {
  try {
    const data = await slackGet('conversations.replies', {
      channel: channelId,
      ts,
      limit: '50',
    })
    const msgs = (data.messages as SlackMessage[]) ?? []
    // First message is the parent — skip it
    return msgs.slice(1).map((m) => ({
      user: m.user,
      username: m.username,
      text: m.text,
      ts: m.ts,
    }))
  } catch {
    return []
  }
}

export async function postMessage(channelId: string, text: string): Promise<void> {
  await slackPost('chat.postMessage', {
    channel: channelId,
    text,
    username: 'Builder Bot',
    icon_emoji: ':hammer_and_wrench:',
  })
}

export function makeDeepLink(channelId: string, ts: string): string {
  // Slack deep link: remove the dot from the timestamp
  const tsClean = ts.replace('.', '')
  return `https://slack.com/archives/${channelId}/p${tsClean}`
}
