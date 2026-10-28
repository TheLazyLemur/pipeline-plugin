import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from '../pipeline-agents/src/store.ts'
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
  const md = tracker([{ id: 1, title: 'renamed', url: null, body: null }, { id: 2, title: 'two', url: 'https://t/2', body: 'the body' }], [], [])

  // when
  // ... sync runs
  await sync(run, db, md)

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
  const md = tracker(
    [{ id: 1, title: 'one', url: null, body: null }, { id: 2, title: 'two', url: null, body: null }],
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
  const waiting = [1, 2, 3].map(id => ({ id, title: `t${id}`, url: null, body: null }))
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

/** The tracker.md sections stacking needs, after the sync commands. */
const stacking = `## Open a stacked PR
Find the blocker PR's head branch, branch from it, open the PR on it.
## Bring a stacked PR up to date
\`\`\`sh
true
\`\`\`
`

/** Ticket 2 waiting, blocked by the tickets in `by`, none done. */
const dependent = (by: number[]) =>
  tracker([{ id: 2, title: 'two', url: null, body: null }], [], by.map(b => ({ id: 2, blocked_by: b, blocker_done: false }))) + stacking

test('with stacking on, a ticket whose only unfinished blocker has its PR open is pulled in stacked on it', async () => {
  // given
  // ... ticket 1 pr_open and ticket 2 blocked by it alone, at stack depth 2
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)

  // when
  // ... sync runs
  await sync(run, db, dependent([1]), 2)

  // then
  // ... ticket 2 is new, stacked on ticket 1
  assert.deepEqual(await sql(run, db, `select ticket_id, status, stacked_on from tickets order by rowid`), [
    { ticket_id: '1', status: 'pr_open', stacked_on: null },
    { ticket_id: '2', status: 'new', stacked_on: '1' },
  ])
})

test('with stacking on, a ticket is held while its blocker is still in progress', async () => {
  // given
  // ... ticket 1 in_progress with a PR under agent review, and ticket 2 blocked by it
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'in_progress', 'https://git/pr/1')`)

  // when
  // ... sync runs at stack depth 2
  await sync(run, db, dependent([1]), 2)

  // then
  // ... ticket 2 is not in the table
  assert.deepEqual(await sql(run, db, `select ticket_id from tickets`), [{ ticket_id: '1' }])
})

test('with stacking on, a ticket with two unfinished blockers is held', async () => {
  // given
  // ... tickets 1 and 3 pr_open, and ticket 2 blocked by both
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1'), ('3', 'three', 'pr_open', 'https://git/pr/3')`)

  // when
  // ... sync runs at stack depth 2
  await sync(run, db, dependent([1, 3]), 2)

  // then
  // ... ticket 2 is not in the table
  assert.deepEqual(await sql(run, db, `select ticket_id from tickets order by rowid`), [{ ticket_id: '1' }, { ticket_id: '3' }])
})

test('with stacking on, a ticket is held when its stack would pass the stack depth', async () => {
  // given
  // ... ticket 1 pr_open stacked on ticket 0, also pr_open, and ticket 2 blocked by ticket 1, at stack depth 2
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url, stacked_on) values ('0', 'zero', 'pr_open', 'https://git/pr/0', null), ('1', 'one', 'pr_open', 'https://git/pr/1', '0')`)

  // when
  // ... sync runs
  await sync(run, db, dependent([1]), 2)

  // then
  // ... ticket 2 is not in the table
  assert.deepEqual(await sql(run, db, `select ticket_id from tickets order by rowid`), [{ ticket_id: '0' }, { ticket_id: '1' }])
})

test('with stacking on, a ticket is held when another is already stacked on its blocker', async () => {
  // given
  // ... ticket 1 pr_open with ticket 3 already stacked on it, and ticket 2 blocked by ticket 1
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url, stacked_on) values ('1', 'one', 'pr_open', 'https://git/pr/1', null), ('3', 'three', 'in_progress', null, '1')`)

  // when
  // ... sync runs at stack depth 3
  await sync(run, db, dependent([1]), 3)

  // then
  // ... ticket 2 is not in the table
  assert.deepEqual(await sql(run, db, `select ticket_id from tickets order by rowid`), [{ ticket_id: '1' }, { ticket_id: '3' }])
})

test('a ticket done in the tracker frees the tickets stacked on it', async () => {
  // given
  // ... ticket 1 pr_open with ticket 2 stacked on it, and the tracker now has ticket 1 done
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stacked_on) values ('1', 'one', 'pr_open', null), ('2', 'two', 'in_progress', '1')`)

  // when
  // ... sync runs
  await sync(run, db, tracker([], [{ id: 1 }], []))

  // then
  // ... ticket 1 is done and ticket 2 is stacked on nothing
  assert.deepEqual(await sql(run, db, `select ticket_id, status, stacked_on from tickets order by rowid`), [
    { ticket_id: '1', status: 'done', stacked_on: null },
    { ticket_id: '2', status: 'in_progress', stacked_on: null },
  ])
})
