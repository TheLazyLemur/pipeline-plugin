import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A project's tracker tool comes from a third plugin, the `pipeline-tracker` mod /tracker-setup writes. The engine
// skips a plugin's own hooks for the agents it spawned and for its own calls (docs/adr/0001), never another plugin's,
// so both the loop's `$.tool.call` and an agent the loop spawned reach the mod's hook. The loop, the agent and the mod
// are inline stand-ins, as in report-result.test.ts; pipeline-agents, loaded from its folder, sees the agent's call too.

const SESSION = { cwd: '/project', surface: null, isInteractive: false }

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
  // no .claude/pipeline at session start, and no agent_runs row for the agent: its limits let the call through
  on('process.run', async (_, e) => ({ value: { exitCode: e.argv[0] === 'test' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return logs
}

test(
  "a project's tracker tool answers the loop's own call and the call of an agent the loop spawned from its timer",
  {
    plugins: [
      {
        name: 'pipeline-tracker',
        register(on) {
          on('session.start', async ($, e, next) => {
            await $.tool.register({ name: 'tracker', description: 'The project tracker and PR host.', isDeferred: false })
            return next(e)
          })
          // the stand-in answers every op with the op it was asked
          on('tool.call', { tool: 'mcp__pipeline-tracker__tracker' }, async (_, e) => ({ result: { op: e.op } }))
        },
      },
      {
        name: 'pipeline',
        register(on) {
          on('session.start', async ($, e, next) => {
            const started = await next(e)
            $.clock.after(10_000, async () => {
              const answer = await $.tool.call({ tool: 'mcp__pipeline-tracker__tracker', op: 'waiting' })
              $.ui.log(`loop ${JSON.stringify(answer)}`)
              await $.agent.spawn({ description: 'pipeline T-1', subagentType: 'pipeline:implementer-sonnet', prompt: 'mcp__pipeline-tracker__tracker' })
            })
            return started
          })
        },
      },
      {
        name: 'agent',
        register(on) {
          // the implementer's loop: once spawned, it reads its ticket through the tool named in its prompt
          on('agent.spawn', async ($, e, next) => {
            const spawned = await next(e)
            const answer = await $.tool.call({ tool: e.prompt as `mcp__${string}__${string}`, agentId: spawned.agentId, op: 'read', id: 'T-1' })
            $.ui.log(`agent ${JSON.stringify(answer)}`)
            return spawned
          })
        },
      },
    ],
  },
  async ($, on) => {
    // given
    // ... a session with the tracker mod stand-in, the loop stand-in and pipeline-agents
    const clock = mock.clock(on)
    const logs = world(on)
    await $.session.start(SESSION)

    // when
    // ... the loop's timer calls the tracker, then spawns the implementer, which calls it too
    await clock.advance(10_000)

    // then
    // ... the mod's hook answered both
    expect(logs).toEqual(['loop {"result":{"op":"waiting"}}', 'agent {"result":{"op":"read"}}'])
  },
)
