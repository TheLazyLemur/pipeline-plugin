import type { AgentInfo } from 'claude-code'
import { type Role, agentOf } from './agents.ts'
import { isHardStopped, readRun } from './limits.ts'
import { DB, type Run, type Stage, type Ticket, lit, sql } from './store.ts'
import { readRouting, reviewFrom } from './routing.ts'

export const REPORT_TOOL = {
  name: 'report_result',
  description:
    'Reports your result to the pipeline. Call it once, as your last action: status "pr_open" with pr_url once the PR is open, status "reviewed" with findings once the checked findings are posted (verifier only), or status "blocked" with the one question a human must answer.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pr_open', 'reviewed', 'blocked'] },
      pr_url: { type: 'string', description: 'The PR url; required for pr_open.' },
      findings: { type: 'integer', minimum: 0, description: 'How many checked findings the verifier posted; required for reviewed.' },
      question: { type: 'string', description: 'The one question a human must answer; required for blocked.' },
    },
    required: ['status'],
    additionalProperties: false,
  },
  isDeferred: false,
} as const

/** The stage at which each reporting role's result is written; reviewers do not report. */
const REPORTS_AT: Partial<Record<Role, Stage>> = { implementer: 'implement', verifier: 'verify', fixer: 'fix' }

/** The statuses each reporting role may send. */
const SENDS: Partial<Record<Role, readonly string[]>> = { implementer: ['pr_open', 'blocked'], verifier: ['reviewed', 'blocked'], fixer: ['pr_open', 'blocked'] }

/** Updates the ticket only while `in_progress` at `stage` (null reads as implement); resolves whether a row changed. */
const settle = async (run: Run, db: string, ticketId: string, stage: Stage, set: string) =>
  (await sql(run, db, `update tickets set ${set} where ticket_id = ${lit(ticketId)} and status = 'in_progress' and coalesce(stage, 'implement') = ${lit(stage)} returning ticket_id`)).length > 0

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** What a report_result call logs: `changed` is whether the row moved, `deny` the refusal the agent reads, `next` the stage the loop's pass must now start. */
export type Reported = { log: string; changed: boolean; next?: 'review' | 'fix'; deny?: string }

/** Settles the ticket, resolving the changed log, or one saying why nothing changed (`what` is what the agent reported). */
const apply = async (run: Run, db: string, id: string, stage: Stage, set: string, what: string, log: string, next?: Reported['next']): Promise<Reported> => {
  if (await settle(run, db, id, stage, set)) return { log, changed: true, next }
  const [t] = (await sql(run, db, `select status, stage from tickets where ticket_id = ${lit(id)}`)) as Ticket[]
  const now = t === undefined ? 'missing' : t.status === 'in_progress' ? `in_progress at ${t.stage ?? 'implement'}` : t.status
  return { log: `${id} reported ${what} but was already ${now}; nothing changed`, changed: false }
}

/** Records a report_result call; throws the refusal the agent reads. */
const record = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, input: Record<string, unknown>, reviewFrom: number): Promise<Reported> => {
  const who = agentOf(agent, plugin)
  if (who === null) throw new Error('report_result is only for the pipeline agents')
  const stage = REPORTS_AT[who.role]
  if (stage === undefined) throw new Error('reviewers post their findings as one ticket comment and do not call report_result')
  const id = who.ticket
  if (!SENDS[who.role]?.includes(input.status as string)) throw new Error(`the ${who.role} reports status ${SENDS[who.role]?.join(' or ')}, not ${JSON.stringify(input.status)}`)

  if (input.status === 'blocked') {
    const question = text(input.question)
    if (question === null) throw new Error('status blocked needs question')
    return apply(run, db, id, stage, `status = 'needs_human', restarts = 0, question = ${lit(question)}`, 'a question', `${id} needs you: ${question}`)
  }

  if (input.status === 'reviewed') {
    const n = input.findings
    if (!Number.isInteger(n) || (n as number) < 0) throw new Error('status reviewed needs findings, a whole number from 0')
    if (n === 0) return apply(run, db, id, stage, `status = 'pr_open', restarts = 0`, 'no findings', `${id} passed review: its PR is yours`)
    return apply(run, db, id, stage, `stage = 'fix', started = 0`, `${n} findings`, `${id} has ${n} review findings to fix`, 'fix')
  }

  const url = text(input.pr_url)
  if (url === null) throw new Error('status pr_open needs pr_url')
  if (who.role === 'implementer') {
    const [t] = (await sql(run, db, `select difficulty, stage from tickets where ticket_id = ${lit(id)}`)) as Ticket[]
    // a null stage is a ticket started before review existed: its implementer was not told to open a draft
    if (t?.stage === 'implement') {
      if (t.difficulty === null) throw new Error(`${id} is in progress with no difficulty`)
      if (t.difficulty >= reviewFrom)
        return apply(run, db, id, stage, `stage = 'review', started = 0, pr_url = ${lit(url)}`, 'a draft PR', `${id} has a draft PR for review: ${url}`, 'review')
    }
  }
  return apply(run, db, id, stage, `status = 'pr_open', restarts = 0, pr_url = ${lit(url)}`, 'a PR', `${id} has a PR: ${url}`)
}

/**
 * Handles a report_result call; `reviewFrom` is routing.md's review threshold. Every call resolves one log line:
 * a refusal carries the reason the agent reads in `deny`.
 */
export const report = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, input: Record<string, unknown>, reviewFrom: number): Promise<Reported> => {
  try {
    return await record(run, db, plugin, agent, input, reviewFrom)
  } catch (err) {
    const deny = (err as Error).message
    return { log: `${agentOf(agent, plugin)?.ticket ?? agent?.description ?? 'unknown agent'} report_result refused: ${deny}`, changed: false, deny }
  }
}

/**
 * A report_result call end to end, as the pipeline-agents plugin handles it. It only records: a stage it moves the
 * ticket into is left `started = 0` for the loop's pass, since an agent spawned from these hooks would be nested in
 * this plugin and its own calls would skip them (docs/adr/0001). Resolves one log line and, for a refusal, `deny`.
 */
export const onReport = async (run: Run, plugin: string, agent: AgentInfo | undefined, input: Record<string, unknown>): Promise<{ log: string; changed: boolean; deny?: string }> => {
  const r = await report(run, DB, plugin, agent, input, reviewFrom(await readRouting(run)))
  return { log: r.log, changed: r.changed, deny: r.deny }
}

/**
 * The refusal for a pipeline agent's Bash command that mentions pipeline.db, or undefined to let the call run, so
 * report_result is the only way an agent records its result. A text match: it stops the habit, not a workaround.
 */
export const dbRefusal = (agent: AgentInfo | undefined, plugin: string, tool: string, input: Record<string, unknown>): string | undefined =>
  tool === 'Bash' && agentOf(agent, plugin) !== null && String(input.command ?? '').includes('pipeline.db')
    ? `The pipeline agents do not touch pipeline.db: call the ${REPORT_TOOL.name} tool to record your result.`
    : undefined

export type Stop = { block?: string; log?: string }

/** The stage each role works at, reviewers included. */
const WORKS_AT: Record<Role, Stage> = { implementer: 'implement', 'reviewer-spec': 'review', 'reviewer-quality': 'review', verifier: 'verify', fixer: 'fix' }

/**
 * Handles a pipeline agent stopping: one hard-stopped at a limit sends its ticket, if still at its stage, to
 * needs_human naming the limit; an agent that must report is blocked once while its ticket is still at its stage,
 * then the ticket goes to needs_human.
 */
export const stop = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, isContinued: boolean): Promise<Stop> => {
  const who = agentOf(agent, plugin)
  if (who === null || agent === undefined) return {}
  const limited = await readRun(run, db, agent.id)
  if (limited !== undefined && isHardStopped(limited)) {
    const question = `The ${who.role} reached its ${limited.soft_limit} limit (Agent ${limited.soft_limit} limit in routing.md) and was stopped without reporting. Check its branch and PR, then send the ticket back to new or set it pr_open.`
    const moved = await settle(run, db, who.ticket, WORKS_AT[who.role], `status = 'needs_human', restarts = 0, question = ${lit(question)}`)
    return moved ? { log: `${who.ticket} needs you: its ${who.role} was stopped at its ${limited.soft_limit} limit` } : {}
  }
  const stage = REPORTS_AT[who.role]
  if (stage === undefined) return {}
  const [open] = await sql(run, db, `select 1 from tickets where ticket_id = ${lit(who.ticket)} and status = 'in_progress' and coalesce(stage, 'implement') = ${lit(stage)}`)
  if (open === undefined) return {}
  if (!isContinued) return { block: `Call the ${REPORT_TOOL.name} tool before you stop: status ${SENDS[who.role]?.join(' or ')}, with the field it needs.` }
  const question = `The ${who.role} stopped without calling report_result. Check its branch and PR, then send the ticket back to new.`
  return (await settle(run, db, who.ticket, stage, `status = 'needs_human', restarts = 0, question = ${lit(question)}`)) ? { log: `${who.ticket} needs you: its ${who.role} stopped without reporting` } : {}
}
