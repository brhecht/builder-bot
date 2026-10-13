// Minimal Linear GraphQL client for the referrer intro DM (TNB-633).
//
// Scope is the TNB CRM team and nothing else: every read filters on the CRM
// team key, and commentOnCrmCard re-reads the issue's team from Linear and
// refuses anything outside it (never Athena, never The New Builder team).
//
// Auth: LINEAR_API_KEY, a Linear personal API key. Comments are posted as the
// key's owner.

import { CrmCard } from './types'

const LINEAR_API = 'https://api.linear.app/graphql'

export function crmTeamKey(): string {
  return process.env.LINEAR_CRM_TEAM_KEY || 'CRM'
}

async function linearGql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY
  if (!key) throw new Error('LINEAR_API_KEY not configured')
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
  })
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] }
  if (!res.ok || json.errors?.length || !json.data) {
    const detail = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new Error(`Linear request failed: ${detail}`)
  }
  return json.data
}

interface RawIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  team?: { key: string } | null
  state?: { name: string; type: string } | null
}

function toCard(n: RawIssue): CrmCard {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    teamKey: n.team?.key ?? '',
    stateName: n.state?.name ?? '',
    stateType: n.state?.type ?? '',
  }
}

const CARD_FIELDS = 'id identifier title description url team { key } state { name type }'

async function findCrmCards(filter: Record<string, unknown>): Promise<CrmCard[]> {
  const key = crmTeamKey()
  const data = await linearGql<{ issues: { nodes: RawIssue[] } }>(
    `query CrmCards($filter: IssueFilter!) { issues(filter: $filter, first: 10) { nodes { ${CARD_FIELDS} } } }`,
    { filter: { ...filter, team: { key: { eq: key } } } },
  )
  return data.issues.nodes.filter((n) => n.team?.key === key).map(toCard)
}

// Cards whose description contains `text` (case-insensitive). Callers re-check
// the exact match; this is only the narrowing query.
export function findCrmCardsByText(text: string): Promise<CrmCard[]> {
  return findCrmCards({ description: { containsIgnoreCase: text } })
}

export function findCrmCardsByTitle(title: string): Promise<CrmCard[]> {
  return findCrmCards({ title: { eqIgnoreCase: title } })
}

export async function commentOnCrmCard(card: CrmCard, body: string): Promise<void> {
  const key = crmTeamKey()
  const check = await linearGql<{ issue: { team: { key: string } } | null }>(
    'query CardTeam($id: String!) { issue(id: $id) { team { key } } }',
    { id: card.id },
  )
  if (check.issue?.team.key !== key) {
    throw new Error(`refusing to comment on ${card.identifier}: not in the ${key} team`)
  }
  const data = await linearGql<{ commentCreate: { success: boolean } }>(
    'mutation CrmComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
    { input: { issueId: card.id, body } },
  )
  if (!data.commentCreate.success) throw new Error('Linear commentCreate returned success=false')
}
