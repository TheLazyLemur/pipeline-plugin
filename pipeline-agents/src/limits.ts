import type { ModelUsage } from 'claude-code'
import type { Role } from './agents.ts'
import type { Limits } from './routing.ts'
import { type Run, lit, sql } from './store.ts'

export type Limit = 'token' | 'time'

/** One pipeline agent run's row in `agent_runs`; a restarted agent is a new agent, so a new row. */
export type AgentRun = {
  agent_id: string
  ticket_id: string
  role: Role
  /** Milliseconds since the epoch at the run's first model request. */
  started_at: number
  /** Model requests sent. */
  requests: number
  /** The input side (uncached, cache-written, cache-read) of the latest request that reported usage, as Claude Code counts context. */
  context_tokens: number
  nudged_token: 0 | 1
  nudged_time: 0 | 1
  /** `requests` when the soft stop was reached; null before. */
  soft_stop_at: number | null
  soft_limit: Limit | null
}

/** Model requests a soft-stopped agent still gets to call report_result before its requests stop being sent. */
const GRACE = 2

export type Verdict = { kind: 'nudge' | 'soft' | 'hard'; limit: Limit } | null

/** Past the soft stop's grace: the run's further requests are answered without being sent. */
export const isHardStopped = (r: AgentRun) => r.soft_stop_at !== null && r.requests >= r.soft_stop_at + GRACE

/** What the run is told now: nothing, a nudge at 80% of a limit (once per limit), a soft stop at 100%, or a hard stop GRACE requests after it. */
export const decide = (r: AgentRun, now: number, limits: Limits): Verdict => {
  if (r.soft_stop_at !== null) {
    if (r.soft_limit === null) throw new Error(`agent run ${r.agent_id} soft-stopped with no limit`)
    return { kind: isHardStopped(r) ? 'hard' : 'soft', limit: r.soft_limit }
  }
  const used: Record<Limit, number> = { token: r.context_tokens / limits.tokens, time: (now - r.started_at) / (limits.minutes * 60_000) }
  const over = (['token', 'time'] as const).find(l => used[l] >= 1)
  if (over !== undefined) return { kind: 'soft', limit: over }
  const near = (['token', 'time'] as const).find(l => used[l] >= 0.8 && r[`nudged_${l}`] === 0)
  return near === undefined ? null : { kind: 'nudge', limit: near }
}

export const nudgeText = (l: Limit) => `You've used 80% of your ${l} limit. Finish the step you're on, push what you have, and report. Don't start new work.`

export const softStopText = (l: Limit) => `Limit reached (${l}): call report_result now with what you have.`

const where = (agentId: string) => `where agent_id = ${lit(agentId)}`

/** The run's row, or undefined before its first model request. */
export const readRun = async (run: Run, db: string, agentId: string): Promise<AgentRun | undefined> =>
  ((await sql(run, db, `select * from agent_runs ${where(agentId)}`)) as AgentRun[])[0]

/** The run's row, created at its first model request with `now` as its start; a reload or restarted session reads the one it kept. */
export const openRun = async (run: Run, db: string, agentId: string, who: { ticket: string; role: Role }, now: number): Promise<AgentRun> => {
  const [r] = (await sql(
    run,
    db,
    `insert into agent_runs (agent_id, ticket_id, role, started_at) values (${[agentId, who.ticket, who.role, now].map(lit).join(', ')}) on conflict (agent_id) do nothing;
select * from agent_runs ${where(agentId)}`,
  )) as AgentRun[]
  if (r === undefined) throw new Error(`agent run ${agentId} was not written`)
  return r
}

/** Counts a sent request; its usage, when it has one, is the run's context now, else the last that had one stands. */
export const recordRequest = (run: Run, db: string, agentId: string, usage: ModelUsage | null) =>
  sql(
    run,
    db,
    `update agent_runs set requests = requests + 1, context_tokens = coalesce(${lit(usage === null ? null : usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens)}, context_tokens) ${where(agentId)}`,
  )

/**
 * Records that the run was told a nudge or soft stop, so a nudge is sent once per limit and the soft stop keeps the
 * request count it came at. A nudge resolves one row only to the call that marked it first: parallel tool calls race.
 */
export const markTold = (run: Run, db: string, agentId: string, v: { kind: 'nudge' | 'soft'; limit: Limit }) =>
  sql(
    run,
    db,
    v.kind === 'nudge'
      ? `update agent_runs set nudged_${v.limit} = 1 ${where(agentId)} and nudged_${v.limit} = 0 returning agent_id`
      : `update agent_runs set soft_stop_at = coalesce(soft_stop_at, requests), soft_limit = coalesce(soft_limit, ${lit(v.limit)}) ${where(agentId)}`,
  )
