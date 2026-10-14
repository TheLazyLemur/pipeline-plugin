import type { Register } from 'claude-code'
import { SYNC, TAG, pass } from '../src/loop.ts'
import { record } from '../src/result.ts'
import { DB } from '../src/store.ts'

const FIRST_MS = 10_000
const EVERY_MS = 5 * 60_000

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
          pluginRoot: $.plugin.root,
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

  // an implementer's final line is its result; one that never completes a turn is left to the orphan rule in pass
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) return done
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    if (agent?.spawnedBy !== $.plugin.name || agent.description === SYNC || !agent.description.startsWith(`${TAG} `)) return done
    const ticketId = agent.description.slice(TAG.length + 1)
    try {
      const root = await $.session.root()
      $.ui.log(await record((argv, init) => $.process.run(argv, { cwd: root, ...init }), DB, ticketId, e.answer))
    } catch (err) {
      $.ui.log(`recording ${ticketId} failed: ${(err as Error).message}`)
    }
    return done
  })

  // the loop's agents finishing must not start a turn on the main thread
  const finished = new RegExp(`<summary>(Agent "${TAG} [^"]*" [^<]*)</summary>`)
  on('prompt.submit', ($, e, next) => {
    const done = e.origin.kind === 'task-notification' && e.text.match(finished)
    return done ? { drop: done[1] ?? done[0] } : next(e)
  }).catch(($, e, next) => next(e))
}
