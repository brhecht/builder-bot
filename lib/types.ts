export interface SlackReaction {
  name: string
  count: number
  users?: string[]
}

export interface SlackMessage {
  ts: string
  user?: string
  username?: string
  text: string
  type?: string
  subtype?: string
  reply_count?: number
  attachments?: SlackAttachment[]
  // Present on the conversations.history payload when a message has reactions
  // (requires the reactions:read scope). Used by the weekly Builder of the Week
  // tally — no extra API call needed.
  reactions?: SlackReaction[]
}

export interface SlackReply {
  user?: string
  username?: string
  user_name?: string
  text: string
  ts: string
}

export interface SlackAttachment {
  title?: string
  text?: string
  title_link?: string
  from_url?: string
  thumb_url?: string
}

export interface PendingIntro {
  name: string
  summary: string
  collected_date: string // YYYY-MM-DD
  permalink?: string
}

export interface ConversationCandidate {
  channel_id: string
  channel_name: string
  ts: string
  user_name: string
  text: string
  replies: SlackReply[]
  reply_count: number
  permalink: string
  url?: string
  url_content?: string
}

export interface IntroCandidate {
  ts: string
  raw_text: string
  user_id: string
  user_name: string
  permalink: string
}

export interface ScoredItem {
  candidate: ConversationCandidate
  decision: 'Include' | 'Skip'
  summary?: string
}

// --- Weekly "Builder of the Week" ---

export interface BuilderTopPost {
  ts: string
  permalink: string
  text: string
  channelName: string
  reactions: number
  replies: number
  score: number
}

// Per-author aggregate over the scoring window. score = totalReactions +
// totalReplies (weights live as a constant in the weekly route).
export interface BuilderScore {
  userId: string
  userName: string
  totalReactions: number
  totalReplies: number
  postCount: number
  score: number
  topPost: BuilderTopPost
}

// A past winner, kept in KV to enforce the no-repeat cooldown.
export interface RecentWinner {
  userId: string
  name: string
  week: string // ISO week, e.g. "2026-W23"
}

// Channel + message ts of the currently-pinned announcement, so the next
// week's run can unpin it before pinning the new one.
export interface BowPin {
  channel: string
  ts: string
}
