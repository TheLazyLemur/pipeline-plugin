import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type AgentRun, decide, markTold, openRun, readRun, recordRequest } from '../pipeline-agents/src/limits.ts'
import { limitsFrom } from '../pipeline-agents/src/routing.ts'
import { freshDb, run } from './helpers.ts'

const LIMITS = { tokens: 1000, minutes: 10 }
const MINUTE = 60_000

/** A run started at 0, fresh unless `more` says what it has used and been told. */
const at = (more: Partial<AgentRun> = {}): AgentRun => ({
  agent_id: 'a1',
  ticket_id: 'T-1',
  role: 'implementer',
  started_at: 0,
  requests: 1,
  context_tokens: 0,
  nudged_token: 0,
  nudged_time: 0,
  soft_stop_at: null,
  soft_limit: null,
  ...more,
})

const usage = (input: number, write: number, read: number) => ({ input_tokens: input, output_tokens: 99, cache_creation_input_tokens: write, cache_read_input_tokens: read })

test('a fresh run is told nothing, and under 80% of both limits still nothing', () => {
  // given
  // ... a run just started, and one at 79% of both limits
  const runs = [
    { r: at(), now: 0 },
    { r: at({ context_tokens: 790 }), now: 7.9 * MINUTE },
  ]

  // when
  // ... each is decided
  const verdicts = runs.map(({ r, now }) => decide(r, now, LIMITS))

  // then
  // ... neither is told anything
  assert.deepEqual(verdicts, [null, null])
})

test('80% of either limit nudges, once per limit', () => {
  // given
  // ... runs at 80% of tokens, at 80% of time, at 80% of tokens already nudged for it, and at 80% of both with tokens nudged
  const runs = [
    { r: at({ context_tokens: 800 }), now: 0 },
    { r: at(), now: 8 * MINUTE },
    { r: at({ context_tokens: 800, nudged_token: 1 }), now: 0 },
    { r: at({ context_tokens: 800, nudged_token: 1 }), now: 8 * MINUTE },
  ]

  // when
  // ... each is decided
  const verdicts = runs.map(({ r, now }) => decide(r, now, LIMITS))

  // then
  // ... each limit nudges until it has been nudged, and the other limit still nudges after
  assert.deepEqual(verdicts, [{ kind: 'nudge', limit: 'token' }, { kind: 'nudge', limit: 'time' }, null, { kind: 'nudge', limit: 'time' }])
})

test('100% of either limit soft-stops, nudged or not', () => {
  // given
  // ... runs at the token limit, at the time limit, and at the token limit after its nudge
  const runs = [
    { r: at({ context_tokens: 1000 }), now: 0 },
    { r: at(), now: 10 * MINUTE },
    { r: at({ context_tokens: 1200, nudged_token: 1 }), now: 0 },
  ]

  // when
  // ... each is decided
  const verdicts = runs.map(({ r, now }) => decide(r, now, LIMITS))

  // then
  // ... each is soft-stopped at the limit it reached
  assert.deepEqual(verdicts, [{ kind: 'soft', limit: 'token' }, { kind: 'soft', limit: 'time' }, { kind: 'soft', limit: 'token' }])
})

test('a soft-stopped run is hard-stopped only after two more model requests', () => {
  // given
  // ... a run soft-stopped at its time limit at request 5, then one and two requests later
  const soft = { soft_stop_at: 5, soft_limit: 'time' } as const
  const runs = [at({ ...soft, requests: 5 }), at({ ...soft, requests: 6 }), at({ ...soft, requests: 7 })]

  // when
  // ... each is decided with its context back under the limits
  const verdicts = runs.map(r => decide(r, 0, LIMITS))

  // then
  // ... the soft stop holds through the grace, then the run is hard-stopped at the limit it hit
  assert.deepEqual(verdicts, [{ kind: 'soft', limit: 'time' }, { kind: 'soft', limit: 'time' }, { kind: 'hard', limit: 'time' }])
})

test('the agent limits are read from routing.md, 500000 tokens and 120 minutes when the lines are missing, and a bad one fails', () => {
  // given
  // ... the default routing.md, one with the limits changed, one written before they existed, and one with a typo
  const routing = readFileSync(join(import.meta.dirname, '../skills/tracker-setup/defaults/routing.md'), 'utf8')
  const changed = routing.replace('Agent token limit: 500000', 'agent token limit: 300000').replace('Agent time limit: 120', 'Agent time limit: 45')

  // when
  // ... each is read
  const read = [routing, changed, '# Routing\n'].map(limitsFrom)
  const bad = () => limitsFrom('Agent time limit: 2h')

  // then
  // ... the defaults and the changed values come back, and the typo is named
  assert.deepEqual(read, [
    { tokens: 500_000, minutes: 120 },
    { tokens: 300_000, minutes: 45 },
    { tokens: 500_000, minutes: 120 },
  ])
  assert.throws(bad, /"Agent time limit:" must be a whole number from 1, not "2h"/)
})

test('a run\'s row is created at its first request, kept across a reload, updated per request and told once', async () => {
  // given
  // ... T-1's implementer's first request, then a reload opening the same run later
  const db = await freshDb()
  await openRun(run, db, 'a1', { ticket: 'T-1', role: 'implementer' }, 1000)
  const reopened = await openRun(run, db, 'a1', { ticket: 'T-1', role: 'implementer' }, 9000)

  // when
  // ... two requests are recorded, the second with no usage, and the run is nudged and soft-stopped at its token limit
  await recordRequest(run, db, 'a1', usage(10, 200, 590))
  await recordRequest(run, db, 'a1', null)
  await markTold(run, db, 'a1', { kind: 'nudge', limit: 'token' })
  await markTold(run, db, 'a1', { kind: 'soft', limit: 'token' })
  await markTold(run, db, 'a1', { kind: 'soft', limit: 'time' })

  // then
  // ... the reload kept the first start, the context is the last usage's input side, and the first soft stop stands
  assert.equal(reopened.started_at, 1000)
  assert.deepEqual(await readRun(run, db, 'a1'), {
    agent_id: 'a1',
    ticket_id: 'T-1',
    role: 'implementer',
    started_at: 1000,
    requests: 2,
    context_tokens: 800,
    nudged_token: 1,
    nudged_time: 0,
    soft_stop_at: 2,
    soft_limit: 'token',
  })
})

test('a second run of the same ticket gets its own row with fresh limits', async () => {
  // given
  // ... T-1's verifier soft-stopped, then restarted as a new agent
  const db = await freshDb()
  await openRun(run, db, 'v1', { ticket: 'T-1', role: 'verifier' }, 0)
  await recordRequest(run, db, 'v1', usage(1000, 0, 0))
  await markTold(run, db, 'v1', { kind: 'soft', limit: 'token' })

  // when
  // ... the restarted verifier makes its first request
  const second = await openRun(run, db, 'v2', { ticket: 'T-1', role: 'verifier' }, 5000)

  // then
  // ... it starts clean, and the first run's row is untouched
  assert.deepEqual(decide(second, 5000, LIMITS), null)
  assert.deepEqual(
    { ...second, first: (await readRun(run, db, 'v1'))?.soft_stop_at },
    { agent_id: 'v2', ticket_id: 'T-1', role: 'verifier', started_at: 5000, requests: 0, context_tokens: 0, nudged_token: 0, nudged_time: 0, soft_stop_at: null, soft_limit: null, first: 1 },
  )
})
