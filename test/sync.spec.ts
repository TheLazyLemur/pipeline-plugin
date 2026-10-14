import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from '../src/store.ts'
import { sync } from '../src/sync.ts'
import { freshDb, run } from './helpers.ts'

/** A tracker.md whose three sync commands print the given JSON. */
const tracker = (waiting: unknown[], done: unknown[], blockers: unknown[]) => `# Tracker
## List the tickets waiting to be worked
\`\`\`sh
echo '${JSON.stringify(waiting)}'
\`\`\`
## List the tickets that are done
\`\`\`sh
echo '${JSON.stringify(done)}'
\`\`\`
## List the blockers
\`\`\`sh
echo '${JSON.stringify(blockers)}'
\`\`\`
`

test('waiting tickets are added as new and existing rows keep their status', async () => {
  // given
  // ... one ticket already ready under an old title, and the tracker listing it and a new one
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('1', 'old', 'ready', 'opus')`)
  const md = tracker([{ id: 1, title: 'renamed', url: null }, { id: 2, title: 'two', url: 'https://t/2' }], [], [])

  // when
  // ... sync runs
  await sync(run, db, md)

  // then
  // ... the existing row has the new title and the same status, the new one is new
  assert.deepEqual(await sql(run, db, `select ticket_id, title, url, status from tickets order by rowid`), [
    { ticket_id: '1', title: 'renamed', url: null, status: 'ready' },
    { ticket_id: '2', title: 'two', url: 'https://t/2', status: 'new' },
  ])
})

test('a waiting ticket with an unfinished blocker is not pulled in', async () => {
  // given
  // ... two waiting tickets, one blocked by an open ticket and one by a done ticket
  const db = await freshDb()
  const md = tracker(
    [{ id: 1, title: 'one', url: null }, { id: 2, title: 'two', url: null }],
    [],
    [{ id: 1, blocked_by: 9, blocker_done: false }, { id: 2, blocked_by: 8, blocker_done: true }],
  )

  // when
  // ... sync runs
  await sync(run, db, md)

  // then
  // ... only the ticket whose blocker is done is in the table
  assert.deepEqual(await sql(run, db, `select ticket_id from tickets`), [{ ticket_id: '2' }])
})

test('a ticket that became blocked is removed while new or ready, and kept once started', async () => {
  // given
  // ... three blocked tickets: one new, one ready, one in progress
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status) values ('1', 'one', 'new'), ('2', 'two', 'ready'), ('3', 'three', 'in_progress')`)
  const waiting = [1, 2, 3].map(id => ({ id, title: `t${id}`, url: null }))
  const md = tracker(waiting, [], [1, 2, 3].map(id => ({ id, blocked_by: 9, blocker_done: 0 })))

  // when
  // ... sync runs
  await sync(run, db, md)

  // then
  // ... only the in-progress ticket is left
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets`), [{ ticket_id: '3', status: 'in_progress' }])
})

test('tickets done in the tracker are marked done', async () => {
  // given
  // ... a ticket with its PR open that the tracker now has as done
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status) values ('1', 'one', 'pr_open'), ('2', 'two', 'pr_open')`)
  const md = tracker([], [{ id: 1 }], [])

  // when
  // ... sync runs
  await sync(run, db, md)

  // then
  // ... it is done and the other is untouched
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets order by rowid`), [
    { ticket_id: '1', status: 'done' },
    { ticket_id: '2', status: 'pr_open' },
  ])
})

test('a tracker.md without the blockers command is refused', async () => {
  // given
  // ... a tracker.md written before the blockers command was required
  const db = await freshDb()
  const md = tracker([], [], []).split('## List the blockers')[0] ?? ''

  // when
  // ... sync runs
  const synced = sync(run, db, md)

  // then
  // ... it fails naming the missing section
  await assert.rejects(synced, /no command under "## List the blockers"/)
})
