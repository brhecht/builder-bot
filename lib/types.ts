export interface SlackMessage {
  ts: string
  user?: string
  username?: string
  text: string
  type?: string
  subtype?: string
  reply_count?: number
  attachments?: SlackAttachment[]
}

export interface SlackReply {
  user?: string
  username?: string
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
}

export interface ConversationCandidate {
  channel_id: string
  channel_name: string
  ts: string
  user_name: string
  text: string
  replies: SlackReply[]
  reply_count: number
  url?: string
  url_content?: string
}

export interface IntroCandidate {
  ts: string
  raw_text: string
}

export interface ScoredItem {
  candidate: ConversationCandidate
  decision: 'Include' | 'Skip'
  summary?: string
}
