import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, ModelCompleteResult } from 'claude-code'
import { type Deps, pass } from '../src/loop.ts'
import { type Run, sql } from '../src/store.ts'
import { freshProject } from './helpers.ts'

const live = (description: string) => ({ description, status: 'running', spawnedBy: 'pipeline' }) as AgentInfo

/** Deps over a project, recording every spawn; `refuse` denies them all. */
const deps = (run: Run, agents: AgentInfo[], refuse = false) => {
  const spawned: AgentSpawnArgs[] = []
  const d: Deps = {
    run,
    complete: async () =>
      ({ isAnswered: true, text: '{"ready": true, "question": null, "difficulty": 4, "confidence": 0.7, "model": "opus", "reason": "ok"}' }) as ModelCompleteResult,
    spawn: async args => {
      spawned.push(args)
      return (refuse ? { deny: 'no verdict' } : { model: 'x', agentId: 'a1' }) as AgentSpawnResult
    },
    agents: async () => agents,
    pluginRoot: '/plugin',
    plugin: 'pipeline',
  }
  return { d, spawned }
}

test('the next ready ticket is handed to the implementer for its model', async () => {
  // given
  // ... two ready tickets and no agent running
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'ready', 'fable'), ('T-2', 'two', 'ready', 'sonnet')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... sync is started, the first ticket goes to the fable implementer and is in progress
  assert.deepEqual(spawned.map(s => [s.description, s.subagentType]), [['pipeline sync', undefined], ['pipeline T-1', 'pipeline:implementer-fable']])
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets order by rowid`), [
    { ticket_id: 'T-1', status: 'in_progress' },
    { ticket_id: 'T-2', status: 'ready' },
  ])
})

test('new tickets are triaged in the pass', async () => {
  // given
  // ... a new ticket, an implementer and sync already running
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, body) values ('T-1', 'one', 'in_progress', 'opus', null), ('T-2', 'two', 'new', null, 'the body')`)
  const { d } = deps(run, [live('pipeline sync'), live('pipeline T-1')])
  const prompts: string[] = []
  const complete = d.complete
  d.complete = r => (prompts.push(r.prompt), complete(r))

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... the new ticket carries Haiku's verdict, judged with its body
  assert.deepEqual(await sql(run, db, `select status, model from tickets where ticket_id = 'T-2'`), [{ status: 'ready', model: 'opus' }])
  assert.match(prompts.join(), /the body/)
})

test('nothing is spawned while an implementer is running', async () => {
  // given
  // ... one ticket in progress with its implementer live, and one ready
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'in_progress', 'opus'), ('T-2', 'two', 'ready', 'sonnet')`)
  const { d, spawned } = deps(run, [live('pipeline sync'), live('pipeline T-1')])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... no agent is started and the ready ticket waits
  assert.deepEqual(spawned, [])
  assert.deepEqual(await sql(run, db, `select status from tickets where ticket_id = 'T-2'`), [{ status: 'ready' }])
})

test('a ticket whose implementer is gone without a result goes to needs_human', async () => {
  // given
  // ... a ticket in progress and no implementer live for it
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'in_progress', 'opus')`)
  const { d } = deps(run, [live('pipeline sync')])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... it waits on a human, with a question saying why
  const [row] = await sql(run, db, `select status, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.match(String(row?.question), /stopped without recording/)
})

test('a refused spawn puts the ticket back to ready', async () => {
  // given
  // ... a ready ticket and spawns being refused
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'ready', 'sonnet')`)
  const { d } = deps(run, [live('pipeline sync')], true)

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... the ticket is ready for the next pass and the refusal is logged
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'ready' }])
  assert.match(log.join('\n'), /T-1 not started: no verdict/)
})
