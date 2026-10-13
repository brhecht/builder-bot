// GET /api/referrer-dm?user=<TNB Slack user ID>
//
// Read-only check of the referrer intro DM (TNB-633) for one Slack user. Runs
// every lookup (Slack user, CRM card, "Referred by", referrer in Slack) and
// returns the DM text and CRM comment it would write. Always dry-run,
// whatever REFERRER_DM_ENABLED says: the deps it uses throw on any write, so
// it never sends a DM, never comments in Linear, never touches the KV claim.
//
// Auth: header `Authorization: Bearer <CRON_SECRET>` (header only, so the
// secret never lands in a URL or a log line).

import { NextRequest, NextResponse } from 'next/server'
import { getReferrerDmMode, handleConfirmedJoin } from '@/lib/referrer-dm'
import { readOnlyDeps, referrerDmConfig } from '@/lib/referrer-dm-live'
import { safeEqual } from '@/lib/slack-signature'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || !safeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const user = req.nextUrl.searchParams.get('user') ?? ''
  if (!/^[UW][A-Z0-9]{8,12}$/.test(user)) {
    return NextResponse.json({ error: 'pass ?user=<Slack user ID>' }, { status: 400 })
  }

  const result = await handleConfirmedJoin(user, readOnlyDeps(), referrerDmConfig('dry_run'))
  return NextResponse.json({ flag: getReferrerDmMode(), result })
}
