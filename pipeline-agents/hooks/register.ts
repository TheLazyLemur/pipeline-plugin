import type { Register } from 'claude-code'
import { LOOP_PLUGIN, agentOf } from '../src/agents.ts'
import { REPORT_TOOL, dbRefusal, onReport, stop } from '../src/result.ts'
import { decide, markTold, nudgeText, openRun, readRun, recordRequest, softStopText } from '../src/limits.ts'
import { limitsFrom, readRouting } from '../src/routing.ts'
import { DB, type Run, migrate } from '../src/store.ts'
import { recordTurn } from '../src/usage.ts'

// Every hook that must hear the loop's agents lives here, not in pipeline: a plugin never hears the agents it
// spawned from its own timer (docs/adr/0001). Agents are recognised as spawned by LOOP_PLUGIN.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // awaited before next, so the tool is listed by the implementers' first turn
    await $.tool.register(REPORT_TOOL)
    // the limits write agent_runs from an agent's first request, which may come before the loop's first pass migrates
    try {
      const root = await $.session.root()
      const run: Run = (argv, init) => $.process.run(argv, { cwd: root, ...init })
      if ((await run(['test', '-d', '.claude/pipeline'])).exitCode === 0) await migrate(run, DB)
    } catch (err) {
      $.ui.log(`migrating the pipeline database failed: ${(err as Error).message}`)
    }
    return next(e)
  })

  // the limits, per model request of a pipeline agent: its start and context are recorded, a limit reached is a soft
  // stop, and once the soft stop's grace is spent the request is answered without being sent, so the agent ends
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const who = agentId === undefined ? null : agentOf((await $.agent.list()).find(a => a.id === agentId), LOOP_PLUGIN)
    if (agentId === undefined || who === null) return yield* next(e)
    const root = await $.session.root()
    const run: Run = (argv, init) => $.process.run(argv, { cwd: root, ...init })
    const now = await $.clock.now()
    const r = await openRun(run, DB, agentId, who, now)
    const v = decide(r, now, limitsFrom(await readRouting(run)))
    if (v?.kind === 'hard') {
      $.ui.log(`${who.ticket} ${who.role} hard-stopped at its ${v.limit} limit`)
      const answer = `Stopped: the ${v.limit} limit was reached.`
      yield { kind: 'text', index: 0, text: answer }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    if (v?.kind === 'soft' && r.soft_stop_at === null) {
      await markTold(run, DB, agentId, { kind: 'soft', limit: v.limit })
      $.ui.log(`${who.ticket} ${who.role} soft-stopped at its ${v.limit} limit`)
    }
    const response = yield* next(e)
    await recordRequest(run, DB, agentId, response.usage)
    return response
  })

  // one tool.call hook without a matcher, as the engine allows: a report_result call, then the limits on every other
  // call of a pipeline agent
  on('tool.call', async ($, e, next) => {
    // a pipeline agent's result; refused for any other caller, written only while its ticket is at that agent's stage
    if (e.tool === `mcp__${$.plugin.name}__${REPORT_TOOL.name}`) {
      const agent = (await $.agent.list()).find(a => a.id === e.agentId)
      try {
        const root = await $.session.root()
        const run: Run = (argv, init) => $.process.run(argv, { cwd: root, ...init })
        const r = await onReport(run, LOOP_PLUGIN, agent, e as Record<string, unknown>)
        $.ui.log(r.log)
        if (r.deny !== undefined) return { deny: r.deny }
        return { result: r.changed ? 'Recorded.' : 'Not recorded: the ticket is no longer at your stage.' }
      } catch (err) {
        $.ui.log(`report_result failed: ${(err as Error).message}`)
        return { deny: (err as Error).message }
      }
    }

    // the limits: from 80% of a limit a nudge rides on the result, once per limit; at the limit the call is refused
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    const who = agentOf((await $.agent.list()).find(a => a.id === agentId), LOOP_PLUGIN)
    if (who === null) return next(e)
    const root = await $.session.root()
    const run: Run = (argv, init) => $.process.run(argv, { cwd: root, ...init })
    const r = await readRun(run, DB, agentId)
    // the run's first request opens it: none means the turn.step hook failed, and the call is not held on that
    if (r === undefined) return next(e)
    const v = decide(r, await $.clock.now(), limitsFrom(await readRouting(run)))
    if (v === null) return next(e)
    if (v.kind !== 'nudge') {
      if (r.soft_stop_at === null) {
        await markTold(run, DB, agentId, { kind: 'soft', limit: v.limit })
        $.ui.log(`${who.ticket} ${who.role} soft-stopped at its ${v.limit} limit`)
      }
      return { deny: softStopText(v.limit) }
    }
    const done = await next(e)
    if (done.deny !== undefined) return done
    await markTold(run, DB, agentId, { kind: 'nudge', limit: v.limit })
    $.ui.log(`${who.ticket} ${who.role} nudged at 80% of its ${v.limit} limit`)
    return { ...done, context: [...(done.context ?? []), nudgeText(v.limit)] }
  })

  // a pipeline agent's Bash command that mentions pipeline.db is refused: its result goes through report_result
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const deny = dbRefusal((await $.agent.list()).find(a => a.id === e.agentId), LOOP_PLUGIN, e.tool, e as Record<string, unknown>)
    return deny === undefined ? next(e) : { deny }
  })

  // an implementer, verifier or fixer must report before it stops: blocked once, then its ticket goes to a human
  on('classic.SubagentStop', async ($, e, next) => {
    const done = await next(e)
    const agent = (await $.agent.list()).find(a => a.id === e.agent_id)
    const root = await $.session.root()
    const s = await stop((argv, init) => $.process.run(argv, { cwd: root, ...init }), DB, LOOP_PLUGIN, agent, e.stop_hook_active)
    if (s.log !== undefined) $.ui.log(s.log)
    return s.block === undefined ? done : { ...done, block: s.block }
  })

  // each finished turn of a pipeline agent or an agent it spawned: its tokens and minutes, per ticket and role, for /pipeline-status
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    try {
      const root = await $.session.root()
      await recordTurn((argv, init) => $.process.run(argv, { cwd: root, ...init }), DB, LOOP_PLUGIN, await $.agent.list(), e.agentId, e)
    } catch (err) {
      $.ui.log(`recording a turn's usage failed: ${(err as Error).message}`)
    }
    return next(e)
  })

  // the loop's agents run unattended: a call that would prompt is allowed; deny rules and an org ceiling still stand
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.agentId === undefined || (e.ceiling !== undefined && e.ceiling !== 'allow')) return verdict
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    return agentOf(agent, LOOP_PLUGIN) !== null ? { decision: 'allow', reason: `${$.plugin.name} allows the pipeline agents' calls` } : verdict
  })
}
