import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lit, sql } from '../src/store.ts'
import { freshDb, run } from './helpers.ts'

test('ticket text with quotes and SQL in it round-trips unchanged', async () => {
  // given
  // ... a title that breaks hand-quoted SQL
  const db = await freshDb()
  const title = `it's "x"; -- '); drop table tickets; --`

  // when
  // ... it is written and read back
  await sql(run, db, `insert into tickets (ticket_id, title) values ('T-1', ${lit(title)})`)
  const rows = await sql(run, db, `select title, status, learned from tickets`)

  // then
  // ... the row holds exactly the title, with the defaults
  assert.deepEqual(rows, [{ title, status: 'new', learned: 0 }])
})

test('a status outside the six is refused', async () => {
  // given
  // ... a database with the schema
  const db = await freshDb()

  // when
  // ... a ticket is written with an unknown status
  const write = sql(run, db, `insert into tickets (ticket_id, title, status) values ('T-1', 't', 'blocked')`)

  // then
  // ... sqlite3 refuses it and the error says why
  await assert.rejects(write, /CHECK constraint failed/)
})
