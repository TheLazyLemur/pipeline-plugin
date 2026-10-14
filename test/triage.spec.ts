import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'
import { sql } from '../src/store.ts'
import { triage } from '../src/triage.ts'
import { freshDb, run } from './helpers.ts'

const guides = { readiness: 'Has acceptance criteria.', rubric: '1 trivial .. 5 hard.', routing: '1-2 sonnet' }
const haiku = (text: string) => async () => ({ isAnswered: true, text }) as ModelCompleteResult
const ticket = { ticket_id: 'T-1', title: 'Add login', url: null, body: null }

test('a ready ticket gets its scores, its routed model and status ready', async () => {
  // given
  // ... a new ticket and Haiku judging it ready, its JSON wrapped in prose
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title) values ('T-1', 'Add login')`)
  const complete = haiku('Here: {"ready": true, "question": null, "difficulty": 3, "confidence": 0.8, "model": "opus", "reason": "clear"}')

  // when
  // ... it is triaged
  await triage(run, complete, db, guides, ticket)

  // then
  // ... the row holds the verdict
  assert.deepEqual(await sql(run, db, `select status, question, difficulty, confidence, model, reason from tickets`), [
    { status: 'ready', question: null, difficulty: 3, confidence: 0.8, model: 'opus', reason: 'clear' },
  ])
})

test('a ticket that is not ready goes to needs_human with the question', async () => {
  // given
  // ... a new ticket and Haiku asking for acceptance criteria
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title) values ('T-1', 'Add login')`)
  const complete = haiku('{"ready": false, "question": "Which providers?", "difficulty": 2, "confidence": 0.6, "model": "sonnet", "reason": "no criteria"}')

  // when
  // ... it is triaged
  await triage(run, complete, db, guides, ticket)

  // then
  // ... it waits on a human with the question stored
  assert.deepEqual(await sql(run, db, `select status, question from tickets`), [{ status: 'needs_human', question: 'Which providers?' }])
})

test('a reply that is not a verdict leaves the ticket new and throws', async () => {
  // given
  // ... a new ticket and a difficulty outside 1-5
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title) values ('T-1', 'Add login')`)
  const complete = haiku('{"ready": true, "question": null, "difficulty": 9, "confidence": 0.5, "model": "sonnet", "reason": "x"}')

  // when
  // ... it is triaged
  const done = triage(run, complete, db, guides, ticket)

  // then
  // ... the call fails loudly and the ticket is retried next pass
  await assert.rejects(done, /not a triage verdict/)
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'new' }])
})

test('the ticket body reaches the Haiku prompt', async () => {
  // given
  // ... a new ticket whose body holds its description and acceptance criteria
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title) values ('T-1', 'Add login')`)
  const prompts: string[] = []
  const complete = async (r: ModelCompleteRequest) => {
    prompts.push(r.prompt)
    return { isAnswered: true, text: '{"ready": true, "question": null, "difficulty": 2, "confidence": 0.9, "model": "sonnet", "reason": "clear"}' } as ModelCompleteResult
  }

  // when
  // ... it is triaged
  await triage(run, complete, db, guides, { ...ticket, body: 'Google sign-in.\n- a user can sign in with Google' })

  // then
  // ... Haiku is shown the body
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Google sign-in\.\n- a user can sign in with Google/)
})
