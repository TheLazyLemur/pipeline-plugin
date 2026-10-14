import type { AgentInfo } from 'claude-code'
import { TAG } from './loop.ts'
import { type Run, lit, sql } from './store.ts'

export const REPORT_TOOL = {
  name: 'report_result',
  description:
    'Reports your result to the pipeline. Call it once, as your last action: status "pr_open" with pr_url once the PR is open, or status "blocked" with the one question a human must answer.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pr_open', 'blocked'] },
      pr_url: { type: 'string', description: 'The PR url; required for pr_open.' },
      question: { type: 'string', description: 'The one question a human must answer; required for blocked.' },
    },
    required: ['status'],
    additionalProperties: false,
  },
  isDeferred: false,
} as const

/** The ticket a pipeline implementer works on, or null for any agent this plugin did not spawn as one. */
export const ticketOf = (agent: AgentInfo | undefined, plugin: string): string | null =>
  agent?.spawnedBy === plugin && agent.description.startsWith(`${TAG} `) ? agent.description.slice(TAG.length + 1) : null

/** Updates the ticket only while `in_progress`; resolves whether a row changed. */
const settle = async (run: Run, db: string, ticketId: string, set: string) =>
  (await sql(run, db, `update tickets set ${set} where ticket_id = ${lit(ticketId)} and status = 'in_progress' returning ticket_id`)).length > 0

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** Handles a report_result call. Throws the refusal the agent reads; resolves what to log, null when no row changed. */
export const report = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, input: Record<string, unknown>): Promise<string | null> => {
  const ticketId = ticketOf(agent, plugin)
  if (ticketId === null) throw new Error('report_result is only for the pipeline implementer agents')
  if (input.status === 'pr_open') {
    const url = text(input.pr_url)
    if (url === null) throw new Error('status pr_open needs pr_url')
    return (await settle(run, db, ticketId, `status = 'pr_open', pr_url = ${lit(url)}`)) ? `${ticketId} has a PR: ${url}` : null
  }
  if (input.status === 'blocked') {
    const question = text(input.question)
    if (question === null) throw new Error('status blocked needs question')
    return (await settle(run, db, ticketId, `status = 'needs_human', question = ${lit(question)}`)) ? `${ticketId} needs you: ${question}` : null
  }
  throw new Error(`status must be pr_open or blocked, not ${JSON.stringify(input.status)}`)
}

export type Stop = { block?: string; log?: string }

/** Handles a pipeline implementer stopping: blocked once while its ticket is still in_progress (no report), then sent to needs_human. */
export const stop = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, isContinued: boolean): Promise<Stop> => {
  const ticketId = ticketOf(agent, plugin)
  if (ticketId === null) return {}
  const [open] = await sql(run, db, `select 1 from tickets where ticket_id = ${lit(ticketId)} and status = 'in_progress'`)
  if (open === undefined) return {}
  if (!isContinued) return { block: `Call the ${REPORT_TOOL.name} tool before you stop: status pr_open with pr_url, or status blocked with question.` }
  const question = 'The implementer stopped without calling report_result. Check its branch, then send the ticket back to new.'
  return (await settle(run, db, ticketId, `status = 'needs_human', question = ${lit(question)}`)) ? { log: `${ticketId} needs you: its implementer stopped without reporting` } : {}
}
