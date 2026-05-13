import { Redis } from '@upstash/redis'
import { PendingIntro } from './types'

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
