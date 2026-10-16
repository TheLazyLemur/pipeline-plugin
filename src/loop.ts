import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult } from 'claude-code'
import { ROLES, type Role, TAG, agentOf } from '../pipeline-agents/src/agents.ts'
import { namesWorktree, worktreeOf } from '../pipeline-agents/src/guards.ts'
import { reviewFrom } from '../pipeline-agents/src/routing.ts'
import { DB, type Run, type Stage, type Ticket, lit, migrate, sql } from '../pipeline-agents/src/store.ts'
import { closeMerged, sync } from './sync.ts'
import { type Complete, MODELS, REVIEW_MODEL, triage } from './triage.ts'

export type Deps = {
  /** `$.process.run` with the project root as cwd. */
  run: Run
  complete: Complete
  spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  agents: () => Promise<AgentInfo[]>
  /** `$.plugin.name`, which namespaces the implementer agents. */
  plugin: string
  /** `$.session.id()`: the owner this session's claims carry. */
  session: string
  /** `$.session.root()`: the main checkout, which the agents never change. */
  root: string
  /** `$HOME`, under which the agents' worktrees live. */
  home: string
}

/** The loop chooses each agent's worktree and states it in the spawn prompt; the guard in pipeline-agents holds it to that path. */
const worktreeLine = (d: Pick<Deps, 'root' | 'home'>, ticketId: string, role: Role) => `Worktree: ${worktreeOf(d.home, d.root, ticketId, role)}`

/** Removes every worktree left under the ticket's paths, one per role, then prunes; touches nothing else. Resolves what to log. */
export const removeWorktrees = async (d: Pick<Deps, 'run' | 'root' | 'home'>, ticketId: string): Promise<string[]> => {
  const log: string[] = []
  for (const role of ['implementer', ...ROLES] as const) {
    const path = worktreeOf(d.home, d.root, ticketId, role)
    if ((await d.run(['test', '-e', path])).exitCode !== 0) continue
    const r = await d.run(['git', 'worktree', 'remove', '--force', path])
    log.push(r.exitCode === 0 ? `${ticketId} ${role} left a worktree; removed ${path}` : `${ticketId} ${role} left ${path}, which could not be removed: ${r.stderr.trim()}`)
  }
  await d.run(['git', 'worktree', 'prune'])
  return log
}

const LIVE: readonly string[] = ['pending', 'running', 'waiting']

/** An owner unseen for 3 pass intervals (5 minutes each) is taken as stopped. */
const STALE = `(owner_seen is null or owner_seen < datetime('now', '-15 minutes'))`

/** The agents a stage starts. */
const STARTS: Record<Exclude<Stage, 'implement'>, readonly Role[]> = { review: ['reviewer-spec', 'reviewer-quality'], verify: ['verifier'], fix: ['fixer'] }

/** Spawns the agents of a stage the ticket has just entered: reviewers and verifier on opus, the fixer on the routed model. Resolves what to log. */
export const start = async (d: Pick<Deps, 'run' | 'spawn' | 'plugin' | 'root' | 'home'>, ticketId: string, stage: Exclude<Stage, 'implement'>): Promise<string> => {
  const [t] = (await sql(d.run, DB, `select ticket_id, title, url, model, pr_url from tickets where ticket_id = ${lit(ticketId)}`)) as Ticket[]
  if (t === undefined) throw new Error(`no ticket ${ticketId} to start ${stage} for`)
  const routed = t.model as (typeof MODELS)[number]
  if (!MODELS.includes(routed) || t.pr_url === null) throw new Error(`${ticketId} is at ${stage} with no routed model or PR: ${t.model}, ${t.pr_url}`)
  const model = stage === 'fix' ? routed : REVIEW_MODEL
  for (const role of STARTS[stage]) {
    const s = await d.spawn({
      description: `${TAG} ${ticketId} ${role}`,
      subagentType: `${d.plugin}:${role}`,
      model,
      prompt: `Ticket ${ticketId}: ${t.title}\n${t.url ?? ''}\nPR: ${t.pr_url}\n${worktreeLine(d, ticketId, role)}`,
    })
    if (s.deny === undefined) continue
    const question = `The ${role} could not start: ${s.deny}. The PR is still a draft: finish its review, then set the ticket pr_open.`
    await sql(d.run, DB, `update tickets set status = 'needs_human', restarts = 0, question = ${lit(question)} where ticket_id = ${lit(ticketId)} and status = 'in_progress'`)
    return `${ticketId} needs you: its ${role} could not start: ${s.deny}`
  }
  await sql(d.run, DB, `update tickets set started = 1 where ticket_id = ${lit(ticketId)}`)
  return `${model} is at ${stage} for ${ticketId}`
}

const read = async (run: Run, name: string) => {
  const r = await run(['cat', `.claude/pipeline/${name}.md`])
  return r.exitCode === 0 ? r.stdout : null
}

/** One pass: mark merged PRs done and sync (a tracker failure is logged and the pass goes on), triage every new ticket, move each in_progress ticket this session owns on, send those of a stopped session to a human, claim and spawn the implementer for the next ready one if none is in progress. Resolves what to log. */
export const pass = async (d: Deps): Promise<string[]> => {
  const [tracker, readiness, rubric, routing] = await Promise.all([
    read(d.run, 'tracker'),
    read(d.run, 'readiness'),
    read(d.run, 'rubric'),
    read(d.run, 'routing'),
  ])
  if (tracker === null || readiness === null || rubric === null || routing === null) return [`no .claude/pipeline setup here; run /tracker-setup`]
  await migrate(d.run, DB)
  // heartbeat first, so a pass that fails later still shows this session alive; a ticket from before owners is
  // adopted, so the stage rules below apply to it as they did then
  await sql(d.run, DB, `update tickets set owner = coalesce(owner, ${lit(d.session)}), owner_seen = datetime('now') where status = 'in_progress' and (owner is null or owner = ${lit(d.session)})`)
  const log: string[] = []
  const live = (await d.agents()).filter(a => LIVE.includes(a.status))

  // 1. a merged PR marks its ticket done before sync, so dependents it was holding are released in this pass
  // 2. sync, so what it adds is triaged in this pass
  // a tracker that fails or times out (a laptop waking from sleep) must not hold up the tickets already in the table
  const done: string[] = []
  try {
    const closed = await closeMerged(d.run, DB, tracker)
    for (const id of closed) log.push(`${id} is done: its PR merged`)
    done.push(...closed, ...(await sync(d.run, DB, tracker)))
  } catch (err) {
    log.push(`tracker unreachable: ${(err as Error).message}`)
  }
  // a done ticket's agents are gone, however it got there: whatever worktree one left behind goes
  for (const id of done) log.push(...(await removeWorktrees(d, id)))

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

  // 4. only the owner moves a ticket on: $.agent.list() sees this session's agents alone. Another session's ticket
  // counts toward the one-at-a-time limit while its owner is seen, and goes to a human once it is not.
  // A stage with no agent of its ticket still live moves on: a stage report_result entered gets its agents started
  // here, since only this plugin's spawns are heard by pipeline-agents (docs/adr/0001); finished reviewers hand over
  // to the verifier; a verifier or fixer gone with no result reported (crash, sleep) is started again once; any other
  // agent gone, or one gone a second time, leaves its ticket to a human: an implementer may have pushed a branch
  const busy = (await sql(d.run, DB, `select ticket_id, stage, started, restarts, owner, ${STALE} as stale from tickets where status = 'in_progress' order by rowid`)) as (Ticket & { stale: 0 | 1 })[]
  const working = new Set(live.map(a => agentOf(a, d.plugin)?.ticket))
  let waiting = 0
  for (const t of busy) {
    // the heartbeat adopted every ownerless one, and a claim always sets the owner
    if (t.owner === null) throw new Error(`${t.ticket_id} is in_progress with no owner`)
    if (t.owner !== d.session && t.stale === 0) waiting++
    else if (t.owner !== d.session) {
      const question = `The session that owned this ticket (${t.owner}) stopped, so whatever agent it was running is gone. Check the branch and any PR, then send the ticket back to new or set it pr_open.`
      const moved = await sql(d.run, DB, `update tickets set status = 'needs_human', restarts = 0, question = ${lit(question)} where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress' and owner = ${lit(t.owner)} and ${STALE} returning ticket_id`)
      if (moved.length > 0) log.push(`${t.ticket_id} needs you: its owning session stopped`)
    } else if (working.has(t.ticket_id)) waiting++
    else if (t.started === 0 && t.stage !== null && t.stage !== 'implement') {
      waiting++
      log.push(await start(d, t.ticket_id, t.stage))
    } else if (t.stage === 'review') {
      waiting++
      const moved = await sql(d.run, DB, `update tickets set stage = 'verify', started = 0 where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress' and stage = 'review' returning ticket_id`)
      if (moved.length > 0) log.push(await start(d, t.ticket_id, 'verify'))
    } else if ((t.stage === 'verify' || t.stage === 'fix') && t.restarts === 0) {
      waiting++
      const moved = await sql(d.run, DB, `update tickets set started = 0, restarts = 1 where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress' and stage = ${lit(t.stage)} and restarts = 0 returning ticket_id`)
      if (moved.length > 0) log.push(`${t.ticket_id} ${STARTS[t.stage].join(', ')} vanished; restarting it once`, await start(d, t.ticket_id, t.stage))
    } else {
      const who = t.stage === 'verify' ? 'verifier' : t.stage === 'fix' ? 'fixer' : 'implementer'
      const question =
        who === 'implementer'
          ? 'The implementer stopped without recording a PR or a question. Check its branch, then send the ticket back to new.'
          : `The ${who} stopped without recording a result. The PR is still a draft: check it, then set the ticket pr_open or send it back to new.`
      await sql(d.run, DB, `update tickets set status = 'needs_human', restarts = 0, question = ${lit(question)} where ticket_id = ${lit(t.ticket_id)} and status = 'in_progress'`)
      log.push(`${t.ticket_id} needs you: its ${who} stopped without a result`)
    }
  }
  // one ticket at a time: no new implementer while any ticket is at any stage
  if (waiting > 0) return log

  // a ready id that cannot name a worktree goes to a human before any claim: after one, worktreeLine would throw and
  // leave the ticket in_progress; before one, it would throw every pass and hold up every ticket after it
  const ready = (await sql(d.run, DB, `select ticket_id, title, url, model, difficulty from tickets where status = 'ready' order by rowid`)) as Ticket[]
  for (const t of ready.filter(t => !namesWorktree(t.ticket_id))) {
    const question = `Ticket id ${JSON.stringify(t.ticket_id)} cannot name a worktree: the tracker's ids must be one path segment (letters, digits, and . _ @ + -). Fix the tracker setup, then send the ticket back to new.`
    const moved = await sql(d.run, DB, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(t.ticket_id)} and status = 'ready' returning ticket_id`)
    if (moved.length > 0) log.push(`${t.ticket_id} needs you: its id cannot name a worktree`)
  }
  const next = ready.find(t => namesWorktree(t.ticket_id))
  if (next === undefined) return log
  if (!MODELS.includes(next.model as (typeof MODELS)[number])) throw new Error(`${next.ticket_id} is ready with no routed model: ${next.model}`)
  if (next.difficulty === null) throw new Error(`${next.ticket_id} is ready with no difficulty`)
  const draft = next.difficulty >= reviewFrom(routing)
  // the claim: one statement, so of passes racing (in this session or another) only one gets the row back, and only
  // while nothing is in_progress
  const claimed = await sql(
    d.run,
    DB,
    `update tickets set status = 'in_progress', stage = 'implement', started = 1, owner = ${lit(d.session)}, owner_seen = datetime('now')
     where ticket_id = ${lit(next.ticket_id)} and status = 'ready' and not exists (select 1 from tickets where status = 'in_progress') returning ticket_id`,
  )
  if (claimed.length === 0) return log
  const s = await d.spawn({
    description: `${TAG} ${next.ticket_id}`,
    subagentType: `${d.plugin}:implementer-${next.model}`,
    prompt: `Ticket ${next.ticket_id}: ${next.title}\n${next.url ?? ''}\n${worktreeLine(d, next.ticket_id, 'implementer')}\n\n${
      draft ? 'Open the PR as a draft on the host, with the title prefix "Draft: ": agents review it before the user does.' : 'Open the PR without a "Draft: " title prefix.'
    }`,
  })
  if (s.deny !== undefined) {
    await sql(d.run, DB, `update tickets set status = 'ready', owner = null, owner_seen = null, restarts = 0 where ticket_id = ${lit(next.ticket_id)} and status = 'in_progress'`)
    log.push(`implementer for ${next.ticket_id} not started: ${s.deny}`)
  } else log.push(`${next.model} is implementing ${next.ticket_id}`)
  return log
}
