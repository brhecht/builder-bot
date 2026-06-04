import { Redis } from '@upstash/redis'
import { PendingIntro, RecentWinner, BowPin } from './types'

// Vercel Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN
const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
})

export async function getLastReported(channelId: string): Promise<number> {
  const val = await redis.get<number>(`last_reported_${channelId}`)
  // Default: 24h ago
  return val ?? Math.floor(Date.now() / 1000) - 86400
}

export async function setLastReported(channelId: string, ts: number): Promise<void> {
  await redis.set(`last_reported_${channelId}`, ts)
}

export async function getPendingIntros(): Promise<PendingIntro[]> {
  const val = await redis.get<PendingIntro[]>('pending_intros')
  return val ?? []
}

export async function setPendingIntros(intros: PendingIntro[]): Promise<void> {
  await redis.set('pending_intros', intros)
}

export async function clearPendingIntros(): Promise<void> {
  await redis.del('pending_intros')
}

// Keys (permalinks + URLs) that appeared in the previous run's candidate set.
// Used to dedupe today's recap against yesterday's so the same thread/URL
// doesn't get re-surfaced. Stored as a flat string[] — small enough to keep in
// a single KV blob, no TTL needed (overwritten every successful post).
export async function getLastPostedKeys(): Promise<string[]> {
  const val = await redis.get<string[]>('last_posted_keys')
  return val ?? []
}

export async function setLastPostedKeys(keys: string[]): Promise<void> {
  await redis.set('last_posted_keys', keys)
}

// --- Weekly "Builder of the Week" state ---

// ISO week (e.g. "2026-W23") of the most recent announcement. Used for
// idempotency — the dual-fire Friday cron only announces once per week.
export async function getBowLastWeek(): Promise<string | null> {
  return (await redis.get<string>('bow_last_week')) ?? null
}

export async function setBowLastWeek(week: string): Promise<void> {
  await redis.set('bow_last_week', week)
}

// Channel + ts of the currently-pinned announcement, so next week's run can
// unpin it before pinning the new winner. null = nothing pinned yet.
export async function getBowLastPin(): Promise<BowPin | null> {
  return (await redis.get<BowPin>('bow_last_pin')) ?? null
}

export async function setBowLastPin(pin: BowPin): Promise<void> {
  await redis.set('bow_last_pin', pin)
}

// Recent winners, used to enforce the no-repeat cooldown. Kept as a small
// array; the route trims it to the cooldown window before writing back.
export async function getRecentWinners(): Promise<RecentWinner[]> {
  return (await redis.get<RecentWinner[]>('bow_recent_winners')) ?? []
}

export async function setRecentWinners(winners: RecentWinner[]): Promise<void> {
  await redis.set('bow_recent_winners', winners)
}
