import type { Register } from 'claude-code'
import { LOOP_PLUGIN, agentOf } from '../src/agents.ts'
import { REPORT_TOOL, dbRefusal, onReport, stop } from '../src/result.ts'
import { DB, type Run } from '../src/store.ts'
import { recordTurn } from '../src/usage.ts'

// Every hook that must hear the loop's agents lives here, not in pipeline: a plugin never hears the agents it
// spawned from its own timer (docs/adr/0001). Agents are recognised as spawned by LOOP_PLUGIN.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // awaited before next, so the tool is listed by the implementers' first turn
    await $.tool.register(REPORT_TOOL)
    return next(e)
  })

  // a pipeline agent's result; refused for any other caller, written only while its ticket is at that agent's stage
  on('tool.call', async ($, e, next) => {
    if (e.tool !== `mcp__${$.plugin.name}__${REPORT_TOOL.name}`) return next(e)
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

  // each finished turn of a pipeline agent: its tokens and minutes, per ticket and role, for /pipeline-status
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    try {
      const root = await $.session.root()
      await recordTurn((argv, init) => $.process.run(argv, { cwd: root, ...init }), DB, LOOP_PLUGIN, (await $.agent.list()).find(a => a.id === e.agentId), e)
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
