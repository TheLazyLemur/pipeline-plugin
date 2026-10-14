import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult } from 'claude-code'
import { DB, type Run, type Stage, type Ticket, lit, migrate, sql } from './store.ts'
import { closeMerged, sync } from './sync.ts'
import { type Complete, MODELS, UP, reviewFrom, triage } from './triage.ts'

export type Deps = {
  /** `$.process.run` with the project root as cwd. */
  run: Run
  complete: Complete
  spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  agents: () => Promise<AgentInfo[]>
  /** `$.plugin.name`, which namespaces the implementer agents. */
  plugin: string
}

/** Every pipeline agent's description starts with this; the notification filter keys on it too. */
export const TAG = 'pipeline'
const LIVE: readonly string[] = ['pending', 'running', 'waiting']

/** The review agents, `agents/<role>.md`, each described `pipeline <ticket_id> <role>`; the implementer is `pipeline <ticket_id>`. */
export const ROLES = ['reviewer-spec', 'reviewer-quality', 'verifier', 'fixer'] as const
export type Role = 'implementer' | (typeof ROLES)[number]

/** The agents a stage starts. */
const STARTS: Record<Exclude<Stage, 'implement'>, readonly Role[]> = { review: ['reviewer-spec', 'reviewer-quality'], verify: ['verifier'], fix: ['fixer'] }

/** The ticket and role of an agent this plugin spawned for a ticket, or null for any other agent. */
export const agentOf = (agent: AgentInfo | undefined, plugin: string): { ticket: string; role: Role } | null => {
  if (agent?.spawnedBy !== plugin || !agent.description.startsWith(`${TAG} `)) return null
  const rest = agent.description.slice(TAG.length + 1)
  const role = ROLES.find(r => rest.endsWith(` ${r}`))
  return role === undefined ? { ticket: rest, role: 'implementer' } : { ticket: rest.slice(0, -role.length - 1), role }
}

/** Spawns the agents of a stage the ticket has just entered: reviewers and verifier one tier up, the fixer on the routed model. Resolves what to log. */
export const start = async (d: Pick<Deps, 'run' | 'spawn' | 'plugin'>, ticketId: string, stage: Exclude<Stage, 'implement'>): Promise<string> => {
  const [t] = (await sql(d.run, DB, `select ticket_id, title, url, model, pr_url from tickets where ticket_id = ${lit(ticketId)}`)) as Ticket[]
  if (t === undefined) throw new Error(`no ticket ${ticketId} to start ${stage} for`)
  const routed = t.model as (typeof MODELS)[number]
  if (!MODELS.includes(routed) || t.pr_url === null) throw new Error(`${ticketId} is at ${stage} with no routed model or PR: ${t.model}, ${t.pr_url}`)
  const model = stage === 'fix' ? routed : UP[routed]
  for (const role of STARTS[stage]) {
    const s = await d.spawn({
      description: `${TAG} ${ticketId} ${role}`,
      subagentType: `${d.plugin}:${role}`,
      model,
      prompt: `Ticket ${ticketId}: ${t.title}\n${t.url ?? ''}\nPR: ${t.pr_url}`,
    })
    if (s.deny === undefined) continue
    const question = `The ${role} could not start: ${s.deny}. The PR is still a draft: finish its review, then set the ticket pr_open.`
    await sql(d.run, DB, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(ticketId)} and status = 'in_progress'`)
    return `${ticketId} needs you: its ${role} could not start: ${s.deny}`
  }
  return `${model} is at ${stage} for ${ticketId}`
}

const read = async (run: Run, name: string) => {
  const r = await run(['cat', `.claude/pipeline/${name}.md`])
  return r.exitCode === 0 ? r.stdout : null
}

/** One pass: mark merged PRs done, sync, triage every new ticket, move each in_progress ticket's stage on, spawn the implementer for the next ready one if none is in progress. Resolves what to log. */
export const pass = async (d: Deps): Promise<string[]> => {
  const [tracker, readiness, rubric, routing] = await Promise.all([
    read(d.run, 'tracker'),
    read(d.run, 'readiness'),
    read(d.run, 'rubric'),
    read(d.run, 'routing'),
  ])
  if (tracker === null || readiness === null || rubric === null || routing === null) return [`no .claude/pipeline setup here; run /tracker-setup`]
  await migrate(d.run, DB)
  const log: string[] = []
  const live = (await d.agents()).filter(a => LIVE.includes(a.status))

  // 1. a merged PR marks its ticket done before sync, so dependents it was holding are released in this pass
  for (const id of await closeMerged(d.run, DB, tracker)) log.push(`${id} is done: its PR merged`)

  // 2. sync, so what it adds is triaged in this pass
  await sync(d.run, DB, tracker)

  // 3. triage; a failed ticket stays new and is retried next pass
  const fresh = (await sql(d.run, DB, `select ticket_id, title, url, body from tickets where status = 'new' order by rowid`)) as Ticket[]
  for (const t of fresh) {
    try {
      const v = await triage(d.run, d.complete, DB, { readiness, rubric, routing }, t)
      log.push(v.ready ? `${t.ticket_id} is ready for ${v.model}` : `${t.ticket_id} needs you: ${v.question}`)
    } catch (err) {
      log.push(`${(err as Error).message}`)
    }
  }

  // 4. a stage with no agent of its ticket still live moves on: finished reviewers hand over to the verifier;
  // any other agent gone with no result reported (crash, restart) leaves its ticket to a human
  const busy = (await sql(d.run, DB, `select ticket_id, stage from tickets where status = 'in_progress' order by rowid`)) as Ticket[]
  const working = new Set(live.map(a => agentOf(a, d.plugin)?.ticket))
  let waiting = 0
  for (const t of busy) {
    if (working.has(t.ticket_id)) waiting++
    else if (t.stage === 'review') {
      waiting++
      const moved = await sql(d.run, DB, `update tickets set stage = 'verify' where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress' and stage = 'review' returning ticket_id`)
      if (moved.length > 0) log.push(await start(d, t.ticket_id, 'verify'))
    } else {
      const who = t.stage === 'verify' ? 'verifier' : t.stage === 'fix' ? 'fixer' : 'implementer'
      const question =
        who === 'implementer'
          ? 'The implementer stopped without recording a PR or a question. Check its branch, then send the ticket back to new.'
          : `The ${who} stopped without recording a result. The PR is still a draft: check it, then set the ticket pr_open or send it back to new.`
      await sql(d.run, DB, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress'`)
      log.push(`${t.ticket_id} needs you: its ${who} stopped without a result`)
    }
  }
  // one ticket at a time: no new implementer while any ticket is at any stage
  if (waiting > 0) return log

  const [next] = (await sql(d.run, DB, `select ticket_id, title, url, model, difficulty from tickets where status = 'ready' order by rowid limit 1`)) as Ticket[]
  if (next === undefined) return log
  if (!MODELS.includes(next.model as (typeof MODELS)[number])) throw new Error(`${next.ticket_id} is ready with no routed model: ${next.model}`)
  if (next.difficulty === null) throw new Error(`${next.ticket_id} is ready with no difficulty`)
  const draft = next.difficulty >= reviewFrom(routing)
  await sql(d.run, DB, `update tickets set status = 'in_progress', stage = 'implement' where ticket_id = ${lit(next.ticket_id)} and status = 'ready'`)
  const s = await d.spawn({
    description: `${TAG} ${next.ticket_id}`,
    subagentType: `${d.plugin}:implementer-${next.model}`,
    prompt: `Ticket ${next.ticket_id}: ${next.title}\n${next.url ?? ''}\n\n${
      draft ? 'Open the PR with the title prefix "Draft: ": agents review it before the user does.' : 'Open the PR without a "Draft: " title prefix.'
    }`,
  })
  if (s.deny !== undefined) {
    await sql(d.run, DB, `update tickets set status = 'ready' where ticket_id = ${lit(next.ticket_id)} and status = 'in_progress'`)
    log.push(`implementer for ${next.ticket_id} not started: ${s.deny}`)
  } else log.push(`${next.model} is implementing ${next.ticket_id}`)
  return log
}
