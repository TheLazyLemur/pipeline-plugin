import type { On } from 'claude-code'
import { type Plugin, expect, mock, test } from 'claude-code/testing'
import { DB, SCHEMA } from '../src/store.ts'

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
    if (e.argv[0] === 'test') return out(1, '') // no .claude/pipeline at session start: nothing to migrate
    if (e.argv[0] === 'cat') return out(1, '') // no routing.md: review from difficulty 3
    expect(e.argv.slice(0, 6)).toEqual(['sqlite3', '-bail', '-json', '-cmd', '.timeout 5000', DB])
    const statement = e.argv.at(-1) ?? ''
    if (statement === "select difficulty, stage from tickets where ticket_id = 'T-1'") return out(0, JSON.stringify([row]))
    const set = statement.match(/^update tickets set status = '(\w+)', restarts = 0, pr_url = '([^']+)' where ticket_id = 'T-1' and status = 'in_progress' and coalesce\(stage, 'implement'\) = 'implement' returning ticket_id$/)
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
    // no .claude/pipeline at session start, and no agent_runs row for the agent: its limits let the call through
    on('process.run', async (_, e) => ({ value: { exitCode: e.argv[0] === 'test' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
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

test(
  'pipeline-agents records the usage of a turn.complete from an agent the pipeline plugin spawned from its timer',
  {
    plugins: [
      {
        name: 'pipeline',
        register(on) {
          on('session.start', async ($, e, next) => {
            const started = await next(e)
            $.clock.after(10_000, async () => {
              await $.agent.spawn({ description: 'pipeline T-1 verifier', subagentType: 'pipeline:verifier', prompt: 'check' })
            })
            return started
          })
        },
      },
    ],
  },
  async ($, on) => {
    // given
    // ... a session with the loop stand-in and pipeline-agents, whose sqlite3 calls are kept
    const clock = mock.clock(on)
    world(on)
    const statements: string[] = []
    on('process.run', async (_, e) => {
      if (e.argv[0] === 'test') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      statements.push(e.argv.at(-1) ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start(SESSION)

    // when
    // ... the loop's timer spawns the verifier, and the engine completes a turn of it
    await clock.advance(10_000)
    const usage = { model: 'claude-fable', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
    await $.turn.complete({ agentId: 'agent-1', turnId: 'turn-1', answer: '', durationMs: 90_000, isAborted: false, reason: 'answer', usage })

    // then
    // ... pipeline-agents' hook wrote the turn against T-1's verifier
    expect(statements).toEqual([
      "insert into turns (ticket_id, role, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms) values ('T-1', 'verifier', 'claude-fable', 1, 2, 3, 4, 90000)",
    ])
  },
)

/**
 * A pipeline database holding only agent_runs, beside `routing` as routing.md (none when undefined); shortcut: one
 * row in memory, since the kit runs no sqlite3. Every statement is kept.
 */
const agentRunsDb = (on: On, routing?: string) => {
  const statements: string[] = []
  let row: Record<string, unknown> | null = null
  const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'test') return out(0, '') // .claude/pipeline exists: migrate at session start
    if (e.argv[0] === 'cat') return routing === undefined ? out(1, '') : out(0, routing)
    const statement = e.argv.at(-1) ?? ''
    statements.push(statement)
    if (!statement.includes('agent_runs') || statement === SCHEMA) return out(0, '')
    const opened = statement.match(/^insert into agent_runs \(agent_id, ticket_id, role, started_at\) values \('agent-1', 'T-1', 'implementer', (\d+)\) on conflict/)
    if (opened !== null) row ??= { agent_id: 'agent-1', ticket_id: 'T-1', role: 'implementer', started_at: Number(opened[1]), requests: 0, context_tokens: 0, nudged_token: 0, nudged_time: 0, soft_stop_at: null, soft_limit: null }
    const sent = statement.match(/^update agent_runs set requests = requests \+ 1, context_tokens = coalesce\((\d+), context_tokens\) where agent_id = 'agent-1'$/)
    if (sent !== null && row !== null) Object.assign(row, { requests: Number(row.requests) + 1, context_tokens: Number(sent[1]) })
    const soft = statement.match(/^update agent_runs set soft_stop_at = coalesce\(soft_stop_at, requests\), soft_limit = coalesce\(soft_limit, '(\w+)'\) where agent_id = 'agent-1'$/)
    if (soft !== null && row !== null) Object.assign(row, { soft_stop_at: row.requests, soft_limit: soft[1] })
    expect(opened ?? sent ?? soft ?? statement.match(/^select \* from agent_runs where agent_id = 'agent-1'$/), `an unexpected statement: ${statement}`).not.toBeNull()
    return out(0, JSON.stringify(row === null ? [] : [row]))
  })
  return { statements, row: () => row }
}

test(
  'pipeline-agents refuses a tool call of an agent the pipeline plugin spawned once its context passes the token limit',
  {
    plugins: [
      {
        name: 'pipeline',
        register(on) {
          on('session.start', async ($, e, next) => {
            const started = await next(e)
            $.clock.after(10_000, async () => {
              await $.agent.spawn({ description: 'pipeline T-1', subagentType: 'pipeline:implementer-sonnet', prompt: 'implement' })
            })
            return started
          })
        },
      },
      {
        name: 'agent',
        register(on) {
          // the implementer's loop: after its first model request, a Bash call, whose answer it logs
          on('agent.spawn', async ($, e, next) => {
            const spawned = await next(e)
            $.clock.after(1_000, async () => {
              // agentId is typed for an MCP tool's call alone; the engine carries it for any
              const answer = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: spawned.agentId } as Parameters<typeof $.tool.call>[0])
              $.ui.log(`answer ${JSON.stringify(answer)}`)
            })
            return spawned
          })
        },
      },
    ],
  },
  async ($, on) => {
    // given
    // ... a session with the loop stand-in and pipeline-agents, whose model answers with 501K tokens of context
    const clock = mock.clock(on)
    const { logs } = world(on)
    const db = agentRunsDb(on)
    on('turn.step', async function* (_, e) {
      const usage = { model: 'claude-sonnet', input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 100_000 }
      yield { kind: 'stop', stopReason: 'tool_use', usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage }
    })
    await $.session.start(SESSION)

    // when
    // ... the loop's timer spawns the implementer, the engine sends its first model request, and it calls Bash
    await clock.advance(10_000)
    for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'sonnet', messageCount: 1, agentId: 'agent-1' }));
    await clock.advance(1_000)

    // then
    // ... pipeline-agents migrated at session start, recorded the request's context, and soft-stopped the Bash call
    expect(db.statements[0]).toBe(SCHEMA)
    expect(db.row()).toMatchObject({ requests: 1, context_tokens: 501_000, soft_stop_at: 1, soft_limit: 'token' })
    expect(logs).toEqual(['T-1 implementer soft-stopped at its token limit', 'answer {"deny":"Limit reached (token): call report_result now with what you have."}'])
  },
)

test(
  'a bad limit line in routing.md is logged, and the tool call of an agent the pipeline plugin spawned runs',
  {
    plugins: [
      {
        name: 'pipeline',
        register(on) {
          on('session.start', async ($, e, next) => {
            const started = await next(e)
            $.clock.after(10_000, async () => {
              await $.agent.spawn({ description: 'pipeline T-1', subagentType: 'pipeline:implementer-sonnet', prompt: 'implement' })
            })
            return started
          })
        },
      },
      {
        name: 'agent',
        register(on) {
          // the implementer's loop: after its first model request, a Bash call, whose answer it logs
          on('agent.spawn', async ($, e, next) => {
            const spawned = await next(e)
            $.clock.after(1_000, async () => {
              // agentId is typed for an MCP tool's call alone; the engine carries it for any
              const answer = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: spawned.agentId } as Parameters<typeof $.tool.call>[0])
              $.ui.log(`answer ${JSON.stringify(answer)}`)
            })
            return spawned
          })
        },
      },
    ],
  },
  async ($, on) => {
    // given
    // ... a session with the loop stand-in and pipeline-agents, whose routing.md has a limit that is not a number
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/home/u' }) // the worktree guard checks the Bash call too
    const { logs } = world(on)
    agentRunsDb(on, 'Agent time limit: 2h\n')
    on('turn.step', async function* (_, e) {
      const usage = { model: 'claude-sonnet', input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      yield { kind: 'stop', stopReason: 'tool_use', usage }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage }
    })
    await $.session.start(SESSION)

    // when
    // ... the loop's timer spawns the implementer, the engine sends its first model request, and it calls Bash
    await clock.advance(10_000)
    for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'sonnet', messageCount: 1, agentId: 'agent-1' }));
    await clock.advance(1_000)

    // then
    // ... both hooks logged the bad line and let the request and the call through to what answers beneath them
    expect(logs).toEqual([
      'applying the agent limits to a model request failed: routing.md "Agent time limit:" must be a whole number from 1, not "2h"',
      'applying the agent limits to a tool call failed: routing.md "Agent time limit:" must be a whole number from 1, not "2h"',
      'answer {"deny":"no plugin answered"}',
    ])
  },
)
