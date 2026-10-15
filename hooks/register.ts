import type { Register } from 'claude-code'
import { LOOP_PLUGIN, TAG } from '../pipeline-agents/src/agents.ts'
import { pass } from '../src/loop.ts'

const FIRST_MS = 10_000
// STALE in src/loop.ts is 3 of these intervals: change it with this.
const EVERY_MS = 5 * 60_000

// The loop only. The hooks its agents need are in pipeline-agents: a plugin never hears the agents it spawned from
// its own timer (docs/adr/0001).
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ($.plugin.name !== LOOP_PLUGIN) throw new Error(`the loop plugin must be named ${LOOP_PLUGIN}: pipeline-agents recognises agents by it`)
    const root = await $.session.root()
    // read once, so every claim and heartbeat of this loop carries the same owner
    const session = await $.session.id()
    const home = await $.env.get('HOME')
    if (home === undefined) throw new Error('HOME is unset: the agents\' worktrees live under it')
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
          session,
          root,
          home,
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

  // the loop's agents finishing must not start a turn on the main thread
  const finished = new RegExp(`<summary>(Agent "${TAG} [^"]*" [^<]*)</summary>`)
  on('prompt.submit', ($, e, next) => {
    const done = e.origin.kind === 'task-notification' && e.text.match(finished)
    return done ? { drop: done[1] ?? done[0] } : next(e)
  }).catch(($, e, next) => next(e))
}
