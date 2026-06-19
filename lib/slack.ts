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

async function joinChannel(channelId: string): Promise<void> {
  await slackPost('conversations.join', { channel: channelId })
}

export async function getChannelMessages(channelId: string, oldest: number): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  let joined = false

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
      if (msg.includes('not_in_channel') && !joined) {
        // Auto-join the channel and retry once (requires channels:join scope)
        await joinChannel(channelId)
        joined = true
        continue
      }
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
    // First message is the parent — skip it. Resolve display names for repliers
    // so the LLM can name them in the recap (avoids "one user noted" patterns).
    const tail = msgs.slice(1)
    return await Promise.all(
      tail.map(async (m) => ({
        user: m.user,
        username: m.username,
        user_name: m.user ? await getUserName(m.user) : (m.username ?? ''),
        text: m.text,
        ts: m.ts,
      }))
    )
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
    // Brian (May 6 PM) doesn't want unfurl previews under each item — the
    // visual noise broke the scannable design. Permalinks now live inline
    // as <URL|Author> hyperlinks; these flags suppress any preview Slack
    // would otherwise generate.
    unfurl_links: false,
    unfurl_media: false,
  })
}

// Like postMessage, but returns the ts of the message that was created so the
// caller can pin it (the weekly Builder of the Week flow pins its own post).
export async function postAndGetTs(channelId: string, text: string): Promise<string> {
  const data = await slackPost('chat.postMessage', {
    channel: channelId,
    text,
    username: 'Builder Bot',
    icon_emoji: ':hammer_and_wrench:',
    unfurl_links: false,
    unfurl_media: false,
  })
  return data.ts as string
}

export async function pinMessage(channelId: string, ts: string): Promise<void> {
  await slackPost('pins.add', { channel: channelId, timestamp: ts })
}

// Unpin a previously-pinned message. Already-unpinned / no-pin errors are
// non-fatal — we don't want a stale pin reference to block the new pin.
export async function unpinMessage(channelId: string, ts: string): Promise<void> {
  try {
    await slackPost('pins.remove', { channel: channelId, timestamp: ts })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[builder-bot] unpin non-fatal: ${msg}`)
  }
}

export function makeDeepLink(channelId: string, ts: string): string {
  const tsClean = ts.replace('.', '')
  return `https://slack.com/archives/${channelId}/p${tsClean}`
}

// Returns the user IDs of everyone who replied in a thread, excluding the
// parent message author. Used by the weekly leaderboard to credit reply-writers.
export async function getReplyAuthors(channelId: string, parentTs: string): Promise<string[]> {
  try {
    const data = await slackGet('conversations.replies', { channel: channelId, ts: parentTs, limit: '50' })
    const messages = (data.messages ?? []) as Array<{ ts: string; user?: string }>
    return messages
      .filter((m) => m.ts !== parentTs && m.user)
      .map((m) => m.user as string)
  } catch {
    return []
  }
}
