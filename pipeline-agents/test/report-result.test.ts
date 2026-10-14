import type { On } from 'claude-code'
import { type Plugin, expect, mock, test } from 'claude-code/testing'
import { DB } from '../src/store.ts'

// The engine skips a plugin's hooks for an agent that plugin spawned from its own code (docs/adr/0001). The kit
// loads one plugin from a folder, beside inline plugins that close over nothing, so the loop is a stand-in named
// pipeline that spawns `pipeline T-1` from a timer, as src/loop.ts does. The agent is the inline plugin `agent`:
// its agent.spawn hook makes the agent's report_result call beneath pipeline's spawn, with its own `$`. A call made
// with the test's `$` comes from the engine, is nested in nothing and is answered whichever plugin owns the tool.

const SESSION = { cwd: '/project', surface: null, isInteractive: false }
const PR = 'https://github.com/o/r/pull/1'

/** The implementer's loop: once spawned, it reports its PR to the tool named in its prompt and logs the answer. */
const agent: Plugin = {
  name: 'agent',
  register(on) {
    on('agent.spawn', async ($, e, next) => {
      const spawned = await next(e)
      const answer = await $.tool.call({ tool: e.prompt as `mcp__${string}__${string}`, agentId: spawned.agentId, status: 'pr_open', pr_url: 'https://github.com/o/r/pull/1' }) // the literal of PR: an inline plugin's register closes over nothing of this file
      $.ui.log(`answer ${JSON.stringify(answer)}`)
      return spawned
    })
  },
}

/** Answers what the plugins ask beneath them: the spawned agent is listed as spawned by the spawn's origin. */
const world = (on: On) => {
  const logs: string[] = []
  const agents: { id: string; description: string; type: string; status: 'running'; spawnedBy: string }[] = []
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.root', async () => ({ value: SESSION.cwd }))
  on('tool.register', async (_, e) => ({ value: { tool: e.name } }))
  on('ui.log', async (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('agent.list', async () => ({ value: agents }))
  on('tool.call', async () => ({ deny: 'no plugin answered' }))
  on('agent.spawn', async (_, e, next) => {
    agents.push({ id: 'agent-1', description: e.description ?? '', type: 'general-purpose', status: 'running', spawnedBy: next.origin.plugin })
    return { model: 'sonnet', agentId: 'agent-1' }
  })
  return { logs, agents }
}

/** A fresh pipeline.db holding T-1 in progress at implement; shortcut: one row in memory, since the kit runs no sqlite3. */
const pipelineDb = (on: On) => {
  const row = { ticket_id: 'T-1', status: 'in_progress', stage: 'implement', difficulty: 1, pr_url: null as string | null }
  const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'cat') return out(1, '') // no routing.md: review from difficulty 3
    expect(e.argv.slice(0, 6)).toEqual(['sqlite3', '-bail', '-json', '-cmd', '.timeout 5000', DB])
    const statement = e.argv.at(-1) ?? ''
    if (statement === "select difficulty, stage from tickets where ticket_id = 'T-1'") return out(0, JSON.stringify([row]))
    const set = statement.match(/^update tickets set status = '(\w+)', pr_url = '([^']+)' where ticket_id = 'T-1' and status = 'in_progress' and coalesce\(stage, 'implement'\) = 'implement' returning ticket_id$/)
    expect(set, `an unexpected statement: ${statement}`).not.toBeNull()
    Object.assign(row, { status: set?.[1], pr_url: set?.[2] })
    return out(0, JSON.stringify([{ ticket_id: 'T-1' }]))
  })
  return row
}

test(
  'pipeline-agents answers report_result for an agent the pipeline plugin spawned from its timer',
  {
    plugins: [
      {
        name: 'pipeline',
        register(on) {
          on('session.start', async ($, e, next) => {
            const started = await next(e)
            $.clock.after(10_000, async () => {
              await $.agent.spawn({ description: 'pipeline T-1', subagentType: 'pipeline:implementer-sonnet', prompt: 'mcp__pipeline-agents__report_result' })
            })
            return started
          })
        },
      },
      agent,
    ],
  },
  async ($, on) => {
    // given
    // ... a session with the loop stand-in, pipeline-agents, and a fresh pipeline.db with T-1 in progress
    const clock = mock.clock(on)
    const row = pipelineDb(on)
    const { logs, agents } = world(on)
    await $.session.start(SESSION)

    // when
    // ... the loop's timer spawns the implementer, and the implementer reports its PR
    await clock.advance(10_000)

    // then
    // ... the agent was spawned by pipeline, pipeline-agents' hook answered and logged it, and T-1 moved to pr_open
    expect(agents).toMatchObject([{ description: 'pipeline T-1', spawnedBy: 'pipeline' }])
    expect(logs).toEqual([`T-1 has a PR: ${PR}`, 'answer {"result":"Recorded."}'])
    expect(row).toMatchObject({ status: 'pr_open', pr_url: PR })
  },
)

test(
  'report_result goes unanswered when the plugin that spawned the agent also owns the tool',
  {
    plugins: [
      {
        name: 'pipeline',
        register(on) {
          on('session.start', async ($, e, next) => {
            const started = await next(e)
            await $.tool.register({ name: 'report_result', description: 'Reports your result.', inputSchema: { type: 'object' } })
            $.clock.after(10_000, async () => {
              await $.agent.spawn({ description: 'pipeline T-1', subagentType: 'pipeline:implementer-sonnet', prompt: 'mcp__pipeline__report_result' })
            })
            return started
          })
          on('tool.call', async ($, e, next) => (e.tool === 'mcp__pipeline__report_result' ? { result: 'Recorded.' } : next(e)))
        },
      },
      agent,
    ],
  },
  async ($, on) => {
    // given
    // ... the bug ticket 12 fixed: the loop plugin owns report_result, and its hook answers a call from the main loop
    const clock = mock.clock(on)
    const { logs } = world(on)
    await $.session.start(SESSION)
    expect(await $.tool.call({ tool: 'mcp__pipeline__report_result', status: 'pr_open', pr_url: PR })).toEqual({ result: 'Recorded.' })

    // when
    // ... the loop's timer spawns the implementer, and the implementer reports its PR
    await clock.advance(10_000)

    // then
    // ... the engine skipped the spawning plugin's hook, so nothing answered the agent's call
    expect(logs).toEqual(['answer {"deny":"no plugin answered"}'])
  },
)
