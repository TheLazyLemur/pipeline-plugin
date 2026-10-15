import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentInfo } from 'claude-code'
import { sql } from '../pipeline-agents/src/store.ts'
import { recordTurn } from '../pipeline-agents/src/usage.ts'
import { freshDb, run } from './helpers.ts'

const agent = (id: string, description: string, spawnedBy?: string, parentId?: string) => ({ id, description, status: 'running', spawnedBy, parentId }) as AgentInfo

// T-1's implementer and verifier and T-2's implementer, spawned by the loop
const AGENTS = [agent('a1', 'pipeline T-1', 'pipeline'), agent('a2', 'pipeline T-1 verifier', 'pipeline'), agent('a3', 'pipeline T-2', 'pipeline')]

const usage = (model: string, input: number, output: number, read: number, write: number) =>
  ({ model, input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write })

test('pipeline agents\' turns are recorded from turn.complete and summed per ticket and role', async () => {
  // given
  // ... T-1's implementer ran two turns, the second interrupted with no usage, and its verifier one; T-2's implementer one
  const db = await freshDb()
  await recordTurn(run, db, 'pipeline', AGENTS, 'a1', { durationMs: 120_000, usage: usage('claude-sonnet', 10, 20, 300, 40) })
  await recordTurn(run, db, 'pipeline', AGENTS, 'a1', { durationMs: 60_000 })
  await recordTurn(run, db, 'pipeline', AGENTS, 'a2', { durationMs: 90_000, usage: usage('claude-opus', 1, 2, 3, 4) })
  await recordTurn(run, db, 'pipeline', AGENTS, 'a3', { durationMs: 30_000, usage: usage('claude-sonnet', 5, 5, 5, 5) })

  // when
  // ... the usage is read per ticket and role, and per ticket
  const roles = await sql(run, db, `select * from role_usage order by ticket_id, role`)
  const tickets = await sql(run, db, `select * from ticket_usage order by ticket_id`)

  // then
  // ... each role's turns are summed with the model it ran on, and each ticket's total covers all its roles
  assert.deepEqual(roles, [
    { ticket_id: 'T-1', role: 'implementer', model: 'claude-sonnet', turns: 2, tokens: 370, input_tokens: 10, output_tokens: 20, cache_read_tokens: 300, cache_write_tokens: 40, minutes: 3 },
    { ticket_id: 'T-1', role: 'verifier', model: 'claude-opus', turns: 1, tokens: 10, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, minutes: 1.5 },
    { ticket_id: 'T-2', role: 'implementer', model: 'claude-sonnet', turns: 1, tokens: 20, input_tokens: 5, output_tokens: 5, cache_read_tokens: 5, cache_write_tokens: 5, minutes: 0.5 },
  ])
  assert.deepEqual(tickets, [
    { ticket_id: 'T-1', tokens: 380, minutes: 4.5 },
    { ticket_id: 'T-2', tokens: 20, minutes: 0.5 },
  ])
})

test('a turn of an agent the loop did not spawn is not recorded', async () => {
  // given
  // ... a subagent the model spawned, described like a pipeline agent
  const db = await freshDb()

  // when
  // ... its turn completes
  const recorded = await recordTurn(run, db, 'pipeline', [agent('a9', 'pipeline T-1')], 'a9', { durationMs: 60_000, usage: usage('claude-sonnet', 1, 1, 1, 1) })

  // then
  // ... nothing is written
  assert.equal(recorded, false)
  assert.deepEqual(await sql(run, db, `select * from turns`), [])
})

test('a turn of an agent a pipeline agent spawned is recorded against that pipeline agent\'s ticket and role', async () => {
  // given
  // ... an Explore the T-1 verifier spawned, and a fork that Explore spawned in turn
  const db = await freshDb()
  const agents = [...AGENTS, agent('c1', 'find callers', undefined, 'a2'), agent('c2', 'fork', undefined, 'c1')]

  // when
  // ... a turn of each completes
  await recordTurn(run, db, 'pipeline', agents, 'c1', { durationMs: 60_000, usage: usage('claude-haiku', 1, 1, 1, 1) })
  await recordTurn(run, db, 'pipeline', agents, 'c2', { durationMs: 60_000, usage: usage('claude-haiku', 2, 2, 2, 2) })

  // then
  // ... both count against T-1's verifier
  assert.deepEqual(await sql(run, db, `select ticket_id, role, model, turns, tokens, minutes from role_usage`), [
    { ticket_id: 'T-1', role: 'verifier', model: 'claude-haiku', turns: 2, tokens: 12, minutes: 2 },
  ])
})
