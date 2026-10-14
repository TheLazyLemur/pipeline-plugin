import type { Register } from 'claude-code'
import { TAG, pass } from '../src/loop.ts'

const EVERY_MS = 5 * 60_000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const root = await $.session.root()
    let isRunning = false
    $.clock.every(EVERY_MS, async () => {
      if (isRunning) return
      isRunning = true
      try {
        const lines = await pass({
          run: (argv, init) => $.process.run(argv, { cwd: root, ...init }),
          complete: request => $.model.complete(request),
          spawn: args => $.agent.spawn(args),
          agents: () => $.agent.list(),
          pluginRoot: $.plugin.root,
          plugin: $.plugin.name,
        })
        for (const line of lines) $.ui.log(line)
      } catch (err) {
        $.ui.log(`${TAG}: pass failed: ${(err as Error).message}`)
      } finally {
        isRunning = false
      }
    })
    return started
  })

  // the loop's agents finishing must not start a turn on the main thread
  const finished = new RegExp(`<summary>(Agent "${TAG} [^"]*" [^<]*)</summary>`)
  on('prompt.submit', ($, e, next) => {
    const done = e.origin.kind === 'task-notification' && e.text.match(finished)
    return done ? { drop: done[1] ?? done[0] } : next(e)
  }).catch(($, e, next) => next(e))
}
