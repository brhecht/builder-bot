import crypto from 'crypto'

// Constant-time string compare that never throws on length mismatch.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

// Slack request signing: HMAC-SHA256 over `v0:{ts}:{rawBody}` with the app's
// signing secret, 5-minute replay window. Malformed timestamps fail closed.
export function verifySlackSignature(raw: string, ts: string | null, sig: string | null, secret: string): boolean {
  if (!ts || !sig) return false
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return false
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')
  return safeEqual(expected, sig)
}
