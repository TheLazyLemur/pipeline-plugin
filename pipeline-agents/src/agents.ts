import type { AgentInfo } from 'claude-code'

/** Every pipeline agent's description starts with this; the notification filter keys on it too. */
export const TAG = 'pipeline'

/** The loop plugin's name: every pipeline agent is spawned by it, which is how pipeline-agents' hooks recognise them. */
export const LOOP_PLUGIN = 'pipeline'

/** The review agents, `agents/<role>.md`, each described `pipeline <ticket_id> <role>`; the implementer is `pipeline <ticket_id>`. */
export const ROLES = ['reviewer-spec', 'reviewer-quality', 'verifier', 'fixer'] as const
export type Role = 'implementer' | (typeof ROLES)[number]

/** The ticket and role of an agent this plugin spawned for a ticket, or null for any other agent. */
export const agentOf = (agent: AgentInfo | undefined, plugin: string): { ticket: string; role: Role } | null => {
  if (agent?.spawnedBy !== plugin || !agent.description.startsWith(`${TAG} `)) return null
  const rest = agent.description.slice(TAG.length + 1)
  const role = ROLES.find(r => rest.endsWith(` ${r}`))
  return role === undefined ? { ticket: rest, role: 'implementer' } : { ticket: rest.slice(0, -role.length - 1), role }
}

