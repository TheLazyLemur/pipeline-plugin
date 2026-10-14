import type { Register } from 'claude-code'
import { TAG, agentOf, pass } from '../src/loop.ts'
import { REPORT_TOOL, dbRefusal, onReport, stop } from '../src/result.ts'
import { DB, type Run } from '../src/store.ts'

const FIRST_MS = 10_000
const EVERY_MS = 5 * 60_000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // awaited before next, so the tool is listed by the implementers' first turn
    await $.tool.register(REPORT_TOOL)
    const started = await next(e)
    const root = await $.session.root()
    let isRunning = false
    const tick = async () => {
      if (isRunning) return
      isRunning = true
      try {
        const lines = await pass({
          run: (argv, init) => $.process.run(argv, { cwd: root, ...init }),
          complete: request => $.model.complete(request),
          spawn: args => $.agent.spawn(args),
          agents: () => $.agent.list(),
          plugin: $.plugin.name,
        })
        for (const line of lines) $.ui.log(line)
      } catch (err) {
        $.ui.log(`pass failed: ${(err as Error).message}`)
      } finally {
        isRunning = false
      }
    }
    // first pass shortly after start rather than a full interval in
    $.clock.after(FIRST_MS, tick)
    $.clock.every(EVERY_MS, tick)
    return started
  })

  // a pipeline agent's result; refused for any other caller, written only while its ticket is at that agent's stage
  on('tool.call', async ($, e, next) => {
    if (e.tool !== `mcp__${$.plugin.name}__${REPORT_TOOL.name}`) return next(e)
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    try {
      const root = await $.session.root()
      const run: Run = (argv, init) => $.process.run(argv, { cwd: root, ...init })
      const r = await onReport({ run, spawn: args => $.agent.spawn(args), plugin: $.plugin.name }, agent, e as Record<string, unknown>)
      for (const line of r.log) $.ui.log(line)
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
    const deny = dbRefusal((await $.agent.list()).find(a => a.id === e.agentId), $.plugin.name, e.tool, e as Record<string, unknown>)
    return deny === undefined ? next(e) : { deny }
  })

  // an implementer, verifier or fixer must report before it stops: blocked once, then its ticket goes to a human
  on('classic.SubagentStop', async ($, e, next) => {
    const done = await next(e)
    const agent = (await $.agent.list()).find(a => a.id === e.agent_id)
    const root = await $.session.root()
    const s = await stop((argv, init) => $.process.run(argv, { cwd: root, ...init }), DB, $.plugin.name, agent, e.stop_hook_active)
    if (s.log !== undefined) $.ui.log(s.log)
    return s.block === undefined ? done : { ...done, block: s.block }
  })

  // the loop's agents run unattended: a call that would prompt is allowed; deny rules and an org ceiling still stand
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.agentId === undefined || (e.ceiling !== undefined && e.ceiling !== 'allow')) return verdict
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    return agentOf(agent, $.plugin.name) !== null ? { decision: 'allow', reason: `${$.plugin.name} allows its own agents' calls` } : verdict
  })

  // the loop's agents finishing must not start a turn on the main thread
  const finished = new RegExp(`<summary>(Agent "${TAG} [^"]*" [^<]*)</summary>`)
  on('prompt.submit', ($, e, next) => {
    const done = e.origin.kind === 'task-notification' && e.text.match(finished)
    return done ? { drop: done[1] ?? done[0] } : next(e)
  }).catch(($, e, next) => next(e))
}
