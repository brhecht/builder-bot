// Real Slack, Linear and KV wiring for lib/referrer-dm.ts.

import { claimReferrerDm, releaseReferrerDm } from './kv'
import { commentOnCrmCard, crmTeamKey, findCrmCardsByText, findCrmCardsByTitle } from './linear'
import { getReferrerDmMode, ReferrerDmConfig, ReferrerDmDeps, ReferrerDmMode } from './referrer-dm'
import { getUserInfo, listUsers, lookupUserByEmail, postMessage } from './slack'

export function referrerDmConfig(mode: ReferrerDmMode = getReferrerDmMode()): ReferrerDmConfig {
  return {
    mode,
    crmTeamKey: crmTeamKey(),
    introChannelId: process.env.SLACK_CHANNEL_INTRODUCE_YOURSELF || undefined,
    skipReferrerIds: (process.env.REFERRER_DM_SKIP_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

export function liveDeps(): ReferrerDmDeps {
  return {
    getUser: getUserInfo,
    lookupUserByEmail,
    listUsers,
    findCrmCardsByText,
    findCrmCardsByTitle,
    sendDm: (slackUserId, text) => postMessage(slackUserId, text),
    commentOnCrmCard,
    claimDm: claimReferrerDm,
    releaseDm: releaseReferrerDm,
    log: (msg) => console.log(`[builder-bot] ${msg}`),
    now: () => new Date(),
  }
}

// Same lookups, but every write throws. Used by the dry-run check endpoint so
// a bug in the mode handling can never turn a check into a real DM.
export function readOnlyDeps(): ReferrerDmDeps {
  const refuse = async (): Promise<never> => { throw new Error('read-only: writes are disabled on this path') }
  return { ...liveDeps(), sendDm: refuse, commentOnCrmCard: refuse, claimDm: refuse, releaseDm: refuse }
}
