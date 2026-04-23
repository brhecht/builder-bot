import { SlackAttachment } from './types'

export interface UrlContent {
  text: string
  source: 'fetch' | 'preview' | 'none'
}

const PAYWALL_SIGNALS = [
  'subscribe to read',
  'subscription required',
  'create an account to continue',
  'sign in to read',
  'sign up to continue',
  'this content is for subscribers',
]

function isPaywalled(text: string): boolean {
  const lower = text.toLowerCase()
  return PAYWALL_SIGNALS.some((s) => lower.includes(s))
}

export function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>)"]+/)
  return match?.[0]
}

export async function fetchUrlContent(url: string, attachment?: SlackAttachment): Promise<UrlContent> {
  if (!url.startsWith('http')) return { text: '', source: 'none' }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BuilderBot/1.0)' },
    })
    clearTimeout(timer)

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('text/html') && !ct.includes('text/plain')) {
      throw new Error('non-text content')
    }

    const html = await res.text()
    const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

    if (isPaywalled(stripped)) throw new Error('paywalled')

    return { text: stripped.slice(0, 2000), source: 'fetch' }
  } catch {
    // Fall back to Slack link preview metadata
    if (attachment) {
      const parts = [attachment.title, attachment.text].filter(Boolean)
      if (parts.length > 0) {
        return { text: parts.join(' — ').slice(0, 500), source: 'preview' }
      }
    }
    return { text: '', source: 'none' }
  }
}
