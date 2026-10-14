import type { AgentInfo } from 'claude-code'
import { type Deps, type Role, agentOf, start } from './loop.ts'
import { DB, type Run, type Stage, type Ticket, lit, sql } from './store.ts'
import { reviewFrom } from './triage.ts'

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

/** What a recorded report logs, and the stage it moved the ticket into whose agents must now be started. */
export type Reported = { log: string; next?: 'review' | 'fix' }

/**
 * Handles a report_result call; `reviewFrom` is routing.md's review threshold. Throws the refusal the agent reads;
 * resolves null when no row changed.
 */
export const report = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, input: Record<string, unknown>, reviewFrom: number): Promise<Reported | null> => {
  const who = agentOf(agent, plugin)
  if (who === null) throw new Error('report_result is only for the pipeline agents')
  const stage = REPORTS_AT[who.role]
  if (stage === undefined) throw new Error('reviewers post their findings as one ticket comment and do not call report_result')
  const id = who.ticket
  if (!SENDS[who.role]?.includes(input.status as string)) throw new Error(`the ${who.role} reports status ${SENDS[who.role]?.join(' or ')}, not ${JSON.stringify(input.status)}`)

  if (input.status === 'blocked') {
    const question = text(input.question)
    if (question === null) throw new Error('status blocked needs question')
    return (await settle(run, db, id, stage, `status = 'needs_human', question = ${lit(question)}`)) ? { log: `${id} needs you: ${question}` } : null
  }

  if (input.status === 'reviewed') {
    const n = input.findings
    if (!Number.isInteger(n) || (n as number) < 0) throw new Error('status reviewed needs findings, a whole number from 0')
    if (n === 0) return (await settle(run, db, id, stage, `status = 'pr_open'`)) ? { log: `${id} passed review: its PR is yours` } : null
    return (await settle(run, db, id, stage, `stage = 'fix'`)) ? { log: `${id} has ${n} review findings to fix`, next: 'fix' } : null
  }

  const url = text(input.pr_url)
  if (url === null) throw new Error('status pr_open needs pr_url')
  if (who.role === 'implementer') {
    const [t] = (await sql(run, db, `select difficulty, stage from tickets where ticket_id = ${lit(id)}`)) as Ticket[]
    // a null stage is a ticket started before review existed: its implementer was not told to open a draft
    if (t?.stage === 'implement') {
      if (t.difficulty === null) throw new Error(`${id} is in progress with no difficulty`)
      if (t.difficulty >= reviewFrom)
        return (await settle(run, db, id, stage, `stage = 'review', pr_url = ${lit(url)}`)) ? { log: `${id} has a draft PR for review: ${url}`, next: 'review' } : null
    }
  }
  return (await settle(run, db, id, stage, `status = 'pr_open', pr_url = ${lit(url)}`)) ? { log: `${id} has a PR: ${url}` } : null
}

/**
 * A report_result call end to end: records it, then starts the agents of the stage it moved the ticket into, while
 * the reporter is still live so the loop's pass never takes that stage for finished. Throws the refusal the agent
 * reads; resolves what to log, null when no row changed.
 */
export const onReport = async (d: Pick<Deps, 'run' | 'spawn' | 'plugin'>, agent: AgentInfo | undefined, input: Record<string, unknown>): Promise<string[] | null> => {
  const routing = await d.run(['cat', '.claude/pipeline/routing.md'])
  const r = await report(d.run, DB, d.plugin, agent, input, reviewFrom(routing.exitCode === 0 ? routing.stdout : ''))
  if (r === null) return null
  if (r.next === undefined) return [r.log]
  const ticket = agentOf(agent, d.plugin)?.ticket as string
  try {
    return [r.log, await start(d, ticket, r.next)]
  } catch (err) {
    // the report is recorded, so the agent is not told it failed
    return [r.log, `${ticket} ${r.next} not started: ${(err as Error).message}`]
  }
}

export type Stop = { block?: string; log?: string }

/** Handles a pipeline agent stopping: an agent that must report is blocked once while its ticket is still at its stage, then the ticket goes to needs_human. */
export const stop = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, isContinued: boolean): Promise<Stop> => {
  const who = agentOf(agent, plugin)
  const stage = who === null ? undefined : REPORTS_AT[who.role]
  if (who === null || stage === undefined) return {}
  const [open] = await sql(run, db, `select 1 from tickets where ticket_id = ${lit(who.ticket)} and status = 'in_progress' and coalesce(stage, 'implement') = ${lit(stage)}`)
  if (open === undefined) return {}
  if (!isContinued) return { block: `Call the ${REPORT_TOOL.name} tool before you stop: status ${SENDS[who.role]?.join(' or ')}, with the field it needs.` }
  const question = `The ${who.role} stopped without calling report_result. Check its branch and PR, then send the ticket back to new.`
  return (await settle(run, db, who.ticket, stage, `status = 'needs_human', question = ${lit(question)}`)) ? { log: `${who.ticket} needs you: its ${who.role} stopped without reporting` } : {}
}
