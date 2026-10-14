// Real Slack, Linear and KV wiring for lib/referrer-dm.ts and lib/join-mark.ts.

import { getJoinMarkMode, JoinMarkConfig, JoinMarkDeps, JoinMarkMode } from './join-mark'
import { claimReferrerDm, releaseReferrerDm } from './kv'
import { commentOnCrmCard, crmTeamKey, findCrmCardsByText, findCrmCardsByTitle, markCrmCard } from './linear'
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

const refuse = async (): Promise<never> => { throw new Error('read-only: writes are disabled on this path') }

// Same lookups, but every write throws. Used by the dry-run check endpoint so
// a bug in the mode handling can never turn a check into a real DM.
export function readOnlyDeps(): ReferrerDmDeps {
  return { ...liveDeps(), sendDm: refuse, commentOnCrmCard: refuse, claimDm: refuse, releaseDm: refuse }
}

// --- Join mark (TNB-674) ---

export function joinMarkConfig(mode: JoinMarkMode = getJoinMarkMode()): JoinMarkConfig {
  return {
    mode,
    crmTeamKey: crmTeamKey(),
    slackLabel: process.env.JOIN_MARK_LABEL || 'TNB SLACK',
    acceptedState: process.env.JOIN_MARK_STATE || '4. Accepted',
  }
}

export function joinMarkLiveDeps(): JoinMarkDeps {
  return {
    getUser: getUserInfo,
    findCrmCardsByText,
    findCrmCardsByTitle,
    markCard: markCrmCard,
    commentOnCrmCard,
    log: (msg) => console.log(`[builder-bot] ${msg}`),
    now: () => new Date(),
  }
}

export function joinMarkReadOnlyDeps(): JoinMarkDeps {
  return { ...joinMarkLiveDeps(), markCard: refuse, commentOnCrmCard: refuse }
}
