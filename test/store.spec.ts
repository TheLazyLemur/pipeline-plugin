import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lit, migrate, sql } from '../pipeline-agents/src/store.ts'
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

test('a database made before the body column gains it, keeping its rows', async () => {
  // given
  // ... a tickets table without body, holding a ticket
  const db = join(mkdtempSync(join(tmpdir(), 'pipeline-')), 'pipeline.db')
  await sql(run, db, `create table tickets (ticket_id text primary key, title text not null); insert into tickets values ('T-1', 'one')`)

  // when
  // ... it is migrated twice, as every loop pass does
  await migrate(run, db)
  await migrate(run, db)

  // then
  // ... the ticket is kept and body can be written
  await sql(run, db, `update tickets set body = 'desc' where ticket_id = 'T-1'`)
  assert.deepEqual(await sql(run, db, `select ticket_id, title, body from tickets`), [{ ticket_id: 'T-1', title: 'one', body: 'desc' }])
})
