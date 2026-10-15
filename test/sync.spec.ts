import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from '../pipeline-agents/src/store.ts'
import { sync } from '../src/sync.ts'
import { fakeTracker, freshDb, run } from './helpers.ts'

/** A tracker tool whose three sync ops return the given results. */
const tracker = (waiting: unknown, done: unknown, blockers: unknown) => fakeTracker({ waiting: () => waiting, done: () => done, blockers: () => blockers })

test('waiting tickets are added as new and existing rows keep their status', async () => {
  // given
  // ... one ticket already ready under an old title, and the tracker listing it and a new one
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('1', 'old', 'ready', 'opus')`)
  const t = tracker([{ id: 1, title: 'renamed', url: null, body: null }, { id: 2, title: 'two', url: 'https://t/2', body: 'the body' }], [], [])

  // when
  // ... sync runs
  await sync(t, run, db)

  // then
  // ... the existing row has the new title and the same status, the new one is new
  assert.deepEqual(await sql(run, db, `select ticket_id, title, url, body, status from tickets order by rowid`), [
    { ticket_id: '1', title: 'renamed', url: null, body: null, status: 'ready' },
    { ticket_id: '2', title: 'two', url: 'https://t/2', body: 'the body', status: 'new' },
  ])
})

test('a waiting ticket with an unfinished blocker is not pulled in', async () => {
  // given
  // ... two waiting tickets, one blocked by an open ticket and one by a done ticket
  const db = await freshDb()
  const t = tracker(
    [{ id: 1, title: 'one', url: null, body: null }, { id: 2, title: 'two', url: null, body: null }],
    [],
    [{ id: 1, blocked_by: 9, blocker_done: false }, { id: 2, blocked_by: 8, blocker_done: true }],
  )

  // when
  // ... sync runs
  await sync(t, run, db)

  // then
  // ... only the ticket whose blocker is done is in the table
  assert.deepEqual(await sql(run, db, `select ticket_id from tickets`), [{ ticket_id: '2' }])
})

test('a ticket that became blocked is removed while new or ready, and kept once started', async () => {
  // given
  // ... three blocked tickets: one new, one ready, one in progress
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status) values ('1', 'one', 'new'), ('2', 'two', 'ready'), ('3', 'three', 'in_progress')`)
  const waiting = [1, 2, 3].map(id => ({ id, title: `t${id}`, url: null, body: null }))
  const t = tracker(waiting, [], [1, 2, 3].map(id => ({ id, blocked_by: 9, blocker_done: 0 })))

  // when
  // ... sync runs
  await sync(t, run, db)

  // then
  // ... only the in-progress ticket is left
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets`), [{ ticket_id: '3', status: 'in_progress' }])
})

test('tickets done in the tracker are marked done', async () => {
  // given
  // ... a ticket with its PR open that the tracker now has as done
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status) values ('1', 'one', 'pr_open'), ('2', 'two', 'pr_open')`)
  const t = tracker([], [{ id: 1 }], [])

  // when
  // ... sync runs
  await sync(t, run, db)

  // then
  // ... it is done and the other is untouched
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets order by rowid`), [
    { ticket_id: '1', status: 'done' },
    { ticket_id: '2', status: 'pr_open' },
  ])
})

test('a blockers result that is not a list of rows is refused', async () => {
  // given
  // ... a tracker whose blockers op returns one object instead of an array
  const db = await freshDb()
  const t = tracker([], [], { id: 1, blocked_by: 2, blocker_done: false })

  // when
  // ... sync runs
  const synced = sync(t, run, db)

  // then
  // ... it fails naming the op
  await assert.rejects(synced, /tracker blockers did not return an array of objects/)
})
