import type { Register } from 'claude-code'
import { LOOP_PLUGIN, TAG } from '../pipeline-agents/src/agents.ts'
import { pass } from '../src/loop.ts'
import { type Prompts, promptsChanged } from '../src/prompts.ts'
import { TRACKER_TOOL, type Tracker } from '../src/sync.ts'

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
    try {
      const entries = await $.fs.list(`${$.plugin.root}/agents`)
      const now: Prompts = Object.fromEntries(entries.filter(f => f.name.endsWith('.md')).map(f => [f.name, f.mtimeMs]))
      const { value: atStart } = await $.state.get({ plugin: 'pipeline', key: 'agentPrompts' })
      if (atStart === undefined) await $.state.set({ plugin: 'pipeline', key: 'agentPrompts' }, now)
      else {
        const line = promptsChanged(atStart, now)
        if (line) $.ui.log(line)
      }
    } catch (err) {
      $.ui.log(`agent prompt check failed: ${(err as Error).message}`)
    }
    let isRunning = false
    const tick = async () => {
      if (isRunning) return
      isRunning = true
      try {
        // looked up each pass: the project's mod loads, reloads and goes away while the session runs
        const tracker: Tracker | null = (await $.tool.list()).some(t => t.name === TRACKER_TOOL)
          ? async (op, args) => {
              const r = await $.tool.call({ tool: TRACKER_TOOL, op, ...args })
              if (r.deny !== undefined) throw new Error(r.deny)
              if (r.isError) throw new Error(`tracker ${op} failed: ${r.text}`)
              return r.result
            }
          : null
        const lines = await pass({
          run: (argv, init) => $.process.run(argv, { cwd: root, ...init }),
          complete: request => $.model.complete(request),
          spawn: args => $.agent.spawn(args),
          agents: () => $.agent.list(),
          plugin: $.plugin.name,
          session,
          root,
          home,
          tracker,
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
