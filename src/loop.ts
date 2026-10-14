import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult } from 'claude-code'
import { DB, type Run, SCHEMA, type Ticket, lit, sql } from './store.ts'
import { type Complete, MODELS, triage } from './triage.ts'

export type Deps = {
  /** `$.process.run` with the project root as cwd. */
  run: Run
  complete: Complete
  spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  agents: () => Promise<AgentInfo[]>
  /** `$.plugin.root`. */
  pluginRoot: string
  /** `$.plugin.name`, which namespaces the implementer agents. */
  plugin: string
}

/** Every pipeline agent's description starts with this; the notification filter keys on it too. */
export const TAG = 'pipeline'
const SYNC = `${TAG} sync`
const LIVE: readonly string[] = ['pending', 'running', 'waiting']

const read = async (run: Run, name: string) => {
  const r = await run(['cat', `.claude/pipeline/${name}.md`])
  return r.exitCode === 0 ? r.stdout : null
}

/** One pass: sync, triage every new ticket, spawn the implementer for the next ready one if none is running. Resolves what to log. */
export const pass = async (d: Deps): Promise<string[]> => {
  const [tracker, readiness, rubric, routing] = await Promise.all([
    read(d.run, 'tracker'),
    read(d.run, 'readiness'),
    read(d.run, 'rubric'),
    read(d.run, 'routing'),
  ])
  if (tracker === null || readiness === null || rubric === null || routing === null) return [`${TAG}: no .claude/pipeline setup here; run /tracker-setup`]
  await sql(d.run, DB, SCHEMA)
  const log: string[] = []
  const live = (await d.agents()).filter(a => a.spawnedBy === d.plugin && LIVE.includes(a.status)).map(a => a.description)

  // 1. sync: an agent following tracker-sync; what it adds is triaged next pass
  if (!live.includes(SYNC)) {
    const s = await d.spawn({ description: SYNC, model: 'haiku', prompt: `Read ${d.pluginRoot}/skills/tracker-sync/SKILL.md and follow it.` })
    if (s.deny !== undefined) log.push(`${TAG}: sync not started: ${s.deny}`)
  }

  // 2. triage; a failed ticket stays new and is retried next pass
  const fresh = (await sql(d.run, DB, `select ticket_id, title, url from tickets where status = 'new' order by rowid`)) as Ticket[]
  for (const t of fresh) {
    try {
      await triage(d.run, d.complete, DB, { readiness, rubric, routing }, t)
    } catch (err) {
      log.push(`${TAG}: ${(err as Error).message}`)
    }
  }

  // 3. an implementer that ended without recording a result leaves its ticket to a human
  const busy = (await sql(d.run, DB, `select ticket_id from tickets where status = 'in_progress'`)) as Ticket[]
  const orphans = busy.filter(t => !live.includes(`${TAG} ${t.ticket_id}`))
  for (const t of orphans) {
    await sql(d.run, DB, `update tickets set status = 'needs_human',
        question = 'The implementer stopped without recording a PR or a question. Check its branch, then send the ticket back to new.'
      where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress'`)
    log.push(`${TAG}: ${t.ticket_id} needs you: its implementer stopped without a result`)
  }
  if (busy.length > orphans.length) return log

  const [next] = (await sql(d.run, DB, `select ticket_id, title, url, model from tickets where status = 'ready' order by rowid limit 1`)) as Ticket[]
  if (next === undefined) return log
  if (!MODELS.includes(next.model as (typeof MODELS)[number])) throw new Error(`${next.ticket_id} is ready with no routed model: ${next.model}`)
  await sql(d.run, DB, `update tickets set status = 'in_progress' where ticket_id = ${lit(next.ticket_id)} and status = 'ready'`)
  const s = await d.spawn({
    description: `${TAG} ${next.ticket_id}`,
    subagentType: `${d.plugin}:implementer-${next.model}`,
    prompt: `Ticket ${next.ticket_id}: ${next.title}\n${next.url ?? ''}`,
  })
  if (s.deny !== undefined) {
    await sql(d.run, DB, `update tickets set status = 'ready' where ticket_id = ${lit(next.ticket_id)} and status = 'in_progress'`)
    log.push(`${TAG}: implementer for ${next.ticket_id} not started: ${s.deny}`)
  } else log.push(`${TAG}: ${next.model} is implementing ${next.ticket_id}`)
  return log
}
