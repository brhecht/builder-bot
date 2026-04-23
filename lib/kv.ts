import { Redis } from '@upstash/redis'
import { PendingIntro } from './types'

const redis = Redis.fromEnv()

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
