import assert from 'node:assert/strict'
import { test } from 'node:test'
import { record } from '../src/result.ts'
import { sql } from '../src/store.ts'
import { freshDb, run } from './helpers.ts'

const inProgress = async () => {
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'in_progress', 'opus')`)
  return db
}

test('a PR: final line opens the ticket with its PR url', async () => {
  // given
  // ... a ticket in progress
  const db = await inProgress()

  // when
  // ... its implementer ends with a report and a PR line
  await record(run, db, 'T-1', 'Added the parser and tests.\n\nPR: https://github.com/o/r/pull/7\n')

  // then
  // ... the ticket is pr_open with the url
  assert.deepEqual(await sql(run, db, `select status, pr_url, question from tickets`), [
    { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7', question: null },
  ])
})

test('a BLOCKED: final line sends the ticket to needs_human with the question, apostrophes intact', async () => {
  // given
  // ... a ticket in progress
  const db = await inProgress()

  // when
  // ... its implementer ends with a question holding an apostrophe and SQL
  await record(run, db, 'T-1', "Stopped.\nBLOCKED: Should the hook use Dan's table'; drop table tickets; --?")

  // then
  // ... the question is stored verbatim and the table survives
  assert.deepEqual(await sql(run, db, `select status, question from tickets`), [
    { status: 'needs_human', question: "Should the hook use Dan's table'; drop table tickets; --?" },
  ])
})

test('an answer with neither final line sends the ticket to needs_human quoting the answer', async () => {
  // given
  // ... a ticket in progress
  const db = await inProgress()

  // when
  // ... its implementer ends with the PR line followed by more prose
  await record(run, db, 'T-1', 'PR: https://github.com/o/r/pull/7\nAll done!')

  // then
  // ... it waits on a human, with the answer in the question
  const [row] = await sql(run, db, `select status, pr_url, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.equal(row?.pr_url, null)
  assert.match(String(row?.question), /without a PR: or BLOCKED: line.*All done!/s)
})
