// Minimal Linear GraphQL client for the referrer intro DM (TNB-633) and the
// join mark (TNB-674).
//
// Scope is the TNB CRM team and nothing else: every read filters on the CRM
// team key, and every write re-reads the issue's team from Linear and refuses
// anything outside it (never Athena, never The New Builder team).
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
  labels?: { nodes: { name: string }[] } | null
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
    labels: (n.labels?.nodes ?? []).map((l) => l.name),
  }
}

const CARD_FIELDS = 'id identifier title description url team { key } state { name type } labels { nodes { name } }'

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

// Re-reads the issue's team from Linear and refuses anything outside TNB CRM.
async function assertCrmCard(card: CrmCard, action: string): Promise<string> {
  const key = crmTeamKey()
  const check = await linearGql<{ issue: { team: { key: string } } | null }>(
    'query CardTeam($id: String!) { issue(id: $id) { team { key } } }',
    { id: card.id },
  )
  if (check.issue?.team.key !== key) {
    throw new Error(`refusing to ${action} ${card.identifier}: not in the ${key} team`)
  }
  return key
}

type MarkChange = { addLabel?: string; moveToState?: string }
type MarkInput = { stateId?: string; addedLabelIds?: string[] }

// Resolves the label and the workflow state by name inside the CRM team,
// from Linear's own lists (no hardcoded IDs). Reads only: the join mark's
// dry run calls it so the log proves the live write would find both.
export async function resolveCrmMark(card: CrmCard, change: MarkChange): Promise<MarkInput> {
  const key = await assertCrmCard(card, 'update')
  const input: MarkInput = {}

  if (change.addLabel) {
    const data = await linearGql<{ issueLabels: { nodes: { id: string; name: string; team: { key: string } | null }[] } }>(
      'query CrmLabel($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 10) { nodes { id name team { key } } } }',
      { name: change.addLabel },
    )
    const label = data.issueLabels.nodes.find((l) => l.team?.key === key) ?? data.issueLabels.nodes.find((l) => !l.team)
    if (!label) throw new Error(`label "${change.addLabel}" not found for the ${key} team`)
    input.addedLabelIds = [label.id]
  }

  if (change.moveToState) {
    const data = await linearGql<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
      'query CrmState($key: String!, $name: String!) { workflowStates(filter: { team: { key: { eq: $key } }, name: { eq: $name } }, first: 2) { nodes { id name } } }',
      { key, name: change.moveToState },
    )
    if (data.workflowStates.nodes.length !== 1) throw new Error(`state "${change.moveToState}" not found once in the ${key} team`)
    input.stateId = data.workflowStates.nodes[0].id
  }
  return input
}

// Adds a label and/or moves the card to a workflow state. Existing labels
// stay (addedLabelIds only adds). Used by the join mark (TNB-674).
export async function markCrmCard(card: CrmCard, change: MarkChange): Promise<void> {
  const input = await resolveCrmMark(card, change)
  if (!input.stateId && !input.addedLabelIds) return
  const data = await linearGql<{ issueUpdate: { success: boolean } }>(
    'mutation CrmMark($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
    { id: card.id, input },
  )
  if (!data.issueUpdate.success) throw new Error('Linear issueUpdate returned success=false')
}

export async function commentOnCrmCard(card: CrmCard, body: string): Promise<void> {
  await assertCrmCard(card, 'comment on')
  const data = await linearGql<{ commentCreate: { success: boolean } }>(
    'mutation CrmComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
    { input: { issueId: card.id, body } },
  )
  if (!data.commentCreate.success) throw new Error('Linear commentCreate returned success=false')
}
