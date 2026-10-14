import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentInfo } from 'claude-code'
import { report, stop } from '../src/result.ts'
import { sql } from '../src/store.ts'
import { freshDb, run } from './helpers.ts'

const implementer = { description: 'pipeline T-1', status: 'running', spawnedBy: 'pipeline' } as AgentInfo

const withTicket = async (status: string) => {
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', '${status}', 'opus')`)
  return db
}

const row = (db: string) => sql(run, db, `select status, pr_url, question from tickets`)

test('pr_open opens the ticket with its PR url and logs it', async () => {
  // given
  // ... a ticket in progress
  const db = await withTicket('in_progress')

  // when
  // ... its implementer reports the PR
  const line = await report(run, db, 'pipeline', implementer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' })

  // then
  // ... the ticket is pr_open with the url, and the change is logged
  assert.deepEqual(await row(db), [{ status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7', question: null }])
  assert.equal(line, 'T-1 has a PR: https://github.com/o/r/pull/7')
})

test('blocked sends the ticket to needs_human with the question, apostrophes intact', async () => {
  // given
  // ... a ticket in progress
  const db = await withTicket('in_progress')

  // when
  // ... its implementer reports a question holding an apostrophe and SQL
  await report(run, db, 'pipeline', implementer, { status: 'blocked', question: "Should the hook use Dan's table'; drop table tickets; --?" })

  // then
  // ... the question is stored verbatim and the table survives
  assert.deepEqual(await row(db), [{ status: 'needs_human', pr_url: null, question: "Should the hook use Dan's table'; drop table tickets; --?" }])
})

test('pr_open without pr_url is refused and leaves the ticket in progress', async () => {
  // given
  // ... a ticket in progress
  const db = await withTicket('in_progress')

  // when
  // ... its implementer reports pr_open with no url
  const call = report(run, db, 'pipeline', implementer, { status: 'pr_open' })

  // then
  // ... the call is refused and the row is unchanged
  await assert.rejects(call, /needs pr_url/)
  assert.deepEqual(await row(db), [{ status: 'in_progress', pr_url: null, question: null }])
})

test('a call from an agent the plugin did not spawn as an implementer is refused', async () => {
  // given
  // ... a ticket in progress and an agent named like an implementer but spawned by someone else
  const db = await withTicket('in_progress')
  const stranger = { ...implementer, spawnedBy: 'other' } as AgentInfo

  // when
  // ... that agent reports a PR
  const call = report(run, db, 'pipeline', stranger, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' })

  // then
  // ... the call is refused and the row is unchanged
  await assert.rejects(call, /only for the pipeline implementer/)
  assert.deepEqual(await row(db), [{ status: 'in_progress', pr_url: null, question: null }])
})

test('a report for a ticket no longer in progress leaves the row unchanged and logs nothing', async () => {
  // given
  // ... a ticket the orphan rule already sent to a human
  const db = await withTicket('needs_human')

  // when
  // ... its implementer reports a PR
  const line = await report(run, db, 'pipeline', implementer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' })

  // then
  // ... nothing changed and there is nothing to log
  assert.deepEqual(await row(db), [{ status: 'needs_human', pr_url: null, question: null }])
  assert.equal(line, null)
})

test('an implementer stopping without a report is blocked once, then its ticket goes to needs_human', async () => {
  // given
  // ... a ticket still in progress
  const db = await withTicket('in_progress')

  // when
  // ... its implementer stops, and stops again after being continued
  const first = await stop(run, db, 'pipeline', implementer, false)
  const second = await stop(run, db, 'pipeline', implementer, true)

  // then
  // ... the first stop is blocked with a reason naming the tool, the second sends the ticket to a human
  assert.match(String(first.block), /report_result/)
  assert.equal(second.block, undefined)
  assert.match(String(second.log), /T-1 needs you/)
  const [r] = await row(db)
  assert.equal(r?.status, 'needs_human')
  assert.match(String(r?.question), /without calling report_result/)
})

test('an implementer that reported may stop', async () => {
  // given
  // ... a ticket its implementer already reported
  const db = await withTicket('pr_open')

  // when
  // ... the implementer stops
  const s = await stop(run, db, 'pipeline', implementer, false)

  // then
  // ... it is neither blocked nor logged
  assert.deepEqual(s, {})
})
