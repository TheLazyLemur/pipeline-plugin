import type { On } from 'claude-code'
import { mock, expect, test } from 'claude-code/testing'

// The guard must hear the loop's agents, so, as in report-result.test.ts, the loop is a stand-in named pipeline that
// spawns `pipeline T-1` from a timer, and the agent's Edit call is made beneath that spawn by the inline plugin `agent`.

const SESSION = { cwd: '/project', surface: null, isInteractive: false }

/** Answers what the plugins ask beneath them: the spawned agent is listed as spawned by the spawn's origin; no pipeline database exists. */
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
  on('tool.call', async () => ({ result: 'edited' }))
  on('agent.spawn', async (_, e, next) => {
    agents.push({ id: 'agent-1', description: e.description ?? '', type: 'general-purpose', status: 'running', spawnedBy: next.origin.plugin })
    return { model: 'sonnet', agentId: 'agent-1' }
  })
  on('process.run', async (_, e) => ({ value: { exitCode: e.argv[0] === 'test' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { logs }
}

test(
  'pipeline-agents refuses an Edit into the main checkout from an agent the pipeline plugin spawned from its timer',
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
          // the implementer's loop: once spawned, an Edit in the main checkout, then one in its worktree, logging each answer
          on('agent.spawn', async ($, e, next) => {
            const spawned = await next(e)
            for (const file_path of ['/project/src/a.ts', '/home/u/.claude/pipeline-worktrees/project/T-1-implementer/src/a.ts']) {
              // agentId is typed for an MCP tool's call alone; the engine carries it for any
              const answer = await $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId: spawned.agentId } as Parameters<typeof $.tool.call>[0])
              $.ui.log(`answer ${JSON.stringify(answer)}`)
            }
            return spawned
          })
        },
      },
    ],
  },
  async ($, on) => {
    // given
    // ... a session with the loop stand-in and pipeline-agents, the project at /project and home at /home/u
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/home/u' })
    const { logs } = world(on)
    await $.session.start(SESSION)

    // when
    // ... the loop's timer spawns the implementer, which edits the main checkout and then its worktree
    await clock.advance(10_000)

    // then
    // ... the first Edit was refused naming the worktree, and the second ran
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatch(/^answer \{"deny":"Edit in the main checkout \(\/project\/src\/a\.ts\) is refused: .*\/home\/u\/\.claude\/pipeline-worktrees\/project\/T-1-implementer/)
    expect(logs[1]).toBe('answer {"result":"edited"}')
  },
)
