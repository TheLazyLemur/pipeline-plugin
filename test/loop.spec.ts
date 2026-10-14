import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, ModelCompleteResult } from 'claude-code'
import { type Deps, pass } from '../src/loop.ts'
import { type Run, lit, sql } from '../src/store.ts'
import { BLOCKERS, DONE, MARK_DONE, MERGED, WAITING } from '../src/sync.ts'
import { freshProject } from './helpers.ts'

const live = (description: string) => ({ description, status: 'running', spawnedBy: 'pipeline' }) as AgentInfo

/** Deps over a project, recording every spawn; `refuse` denies them all. */
const deps = (run: Run, agents: AgentInfo[], refuse = false) => {
  const spawned: AgentSpawnArgs[] = []
  const d: Deps = {
    run,
    complete: async () =>
      ({ isAnswered: true, text: '{"ready": true, "question": null, "difficulty": 4, "confidence": 0.7, "model": "opus", "reason": "ok"}' }) as ModelCompleteResult,
    spawn: async args => {
      spawned.push(args)
      return (refuse ? { deny: 'no verdict' } : { model: 'x', agentId: 'a1' }) as AgentSpawnResult
    },
    agents: async () => agents,
    plugin: 'pipeline',
  }
  return { d, spawned }
}

/** The commands of a SQLite tracker in the project root: `todo` tickets wait, `links` hold "blocked by", merged.txt lists merged PR URLs. */
const COMMANDS: Record<string, string> = {
  [WAITING]: `sqlite3 -json tracker.db "select id, 't' || id as title, null as url, null as body from tickets where status = 'todo'"`,
  [DONE]: `sqlite3 -json tracker.db "select id from tickets where status = 'done'"`,
  [BLOCKERS]: `sqlite3 -json tracker.db "select l.ticket_id as id, l.blocked_by, b.status = 'done' as blocker_done from links l join tickets b on b.id = l.blocked_by"`,
  [MERGED]: `if grep -qxF -- "$1" merged.txt; then echo '{"merged": true}'; else echo '{"merged": false}'; fi`,
  [MARK_DONE]: `case "$1" in ''|*[!0-9]*) exit 2;; esac; sqlite3 tracker.db "update tickets set status = 'done' where id = $1"`,
}

/** Points the project's tracker.md at a fresh SQLite tracker filled by `fill`, with `merged` as the merged PR URLs; `omit` leaves a section out. */
const sqliteTracker = async (run: Run, root: string, fill: string, merged: string[], omit?: string) => {
  await sql(run, 'tracker.db', `create table tickets (id integer primary key, status text not null);
    create table links (ticket_id integer not null, blocked_by integer not null);
    ${fill}`)
  writeFileSync(join(root, 'merged.txt'), merged.map(url => `${url}\n`).join(''))
  const sections = Object.entries(COMMANDS).filter(([h]) => h !== omit)
  writeFileSync(join(root, '.claude/pipeline/tracker.md'), sections.map(([h, cmd]) => `## ${h}\n\`\`\`sh\n${cmd}\n\`\`\`\n`).join(''))
}

test('a merged PR marks its ticket done in the tracker and the table', async () => {
  // given
  // ... a ticket with its PR open and merged
  const { run, db, root } = await freshProject()
  await sqliteTracker(run, root, `insert into tickets values (1, 'in_review');`, ['https://git/pr/1'])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)

  // when
  // ... a pass runs
  const log = await pass(deps(run, []).d)

  // then
  // ... it is done in both, and the pass says so
  assert.deepEqual(await sql(run, 'tracker.db', `select status from tickets`), [{ status: 'done' }])
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'done' }])
  assert.match(log.join('\n'), /1 is done: its PR merged/)
})

test('an unmerged PR leaves its ticket open in the tracker and the table', async () => {
  // given
  // ... a ticket with its PR open and not merged
  const { run, db, root } = await freshProject()
  await sqliteTracker(run, root, `insert into tickets values (1, 'in_review');`, [])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)

  // when
  // ... a pass runs
  await pass(deps(run, []).d)

  // then
  // ... it is still in review and pr_open
  assert.deepEqual(await sql(run, 'tracker.db', `select status from tickets`), [{ status: 'in_review' }])
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'pr_open' }])
})

test('a dependent of a ticket whose PR just merged is pulled in and started in the same pass', async () => {
  // given
  // ... ticket 2 waiting, blocked by ticket 1 whose PR has merged
  const { run, db, root } = await freshProject()
  await sqliteTracker(run, root, `insert into tickets values (1, 'in_review'), (2, 'todo'); insert into links values (2, 1);`, ['https://git/pr/1'])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... ticket 2 is synced, triaged and handed to its implementer
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets order by rowid`), [
    { ticket_id: '1', status: 'done' },
    { ticket_id: '2', status: 'in_progress' },
  ])
  assert.deepEqual(spawned.map(s => s.description), ['pipeline 2'])
})

test('a PR URL reaches the merge check as literal text', async () => {
  // given
  // ... a merged PR whose URL holds quotes, a command separator and a command substitution
  const url = `https://git/pr/1';touch hacked;'$(touch hacked)`
  const { run, db, root } = await freshProject()
  await sqliteTracker(run, root, `insert into tickets values (1, 'in_review');`, [url])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', ${lit(url)})`)

  // when
  // ... a pass runs
  await pass(deps(run, []).d)

  // then
  // ... the check matched the URL exactly, so the ticket is done, and nothing in it ran
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'done' }])
  assert.throws(() => readFileSync(join(root, 'hacked')), { code: 'ENOENT' })
})

for (const missing of [MERGED, MARK_DONE]) {
  test(`a tracker.md without "## ${missing}" fails the pass`, async () => {
    // given
    // ... a tracker.md written before that section was required, and no PR open
    const { run, root } = await freshProject()
    await sqliteTracker(run, root, '', [], missing)

    // when
    // ... a pass runs
    const passed = pass(deps(run, []).d)

    // then
    // ... it fails naming the section and the fix
    await assert.rejects(passed, new RegExp(`no command under "## ${missing}"; run /tracker-setup`))
  })
}

test('the next ready ticket is handed to the implementer for its model', async () => {
  // given
  // ... two ready tickets and no agent running
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'ready', 'fable'), ('T-2', 'two', 'ready', 'sonnet')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... the first ticket goes to the fable implementer and is in progress
  assert.deepEqual(spawned.map(s => [s.description, s.subagentType]), [['pipeline T-1', 'pipeline:implementer-fable']])
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets order by rowid`), [
    { ticket_id: 'T-1', status: 'in_progress' },
    { ticket_id: 'T-2', status: 'ready' },
  ])
})

test('new tickets are triaged in the pass', async () => {
  // given
  // ... a new ticket and an implementer already running
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, body) values ('T-1', 'one', 'in_progress', 'opus', null), ('T-2', 'two', 'new', null, 'the body')`)
  const { d } = deps(run, [live('pipeline T-1')])
  const prompts: string[] = []
  const complete = d.complete
  d.complete = r => (prompts.push(r.prompt), complete(r))

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... the new ticket carries Haiku's verdict, judged with its body
  assert.deepEqual(await sql(run, db, `select status, model from tickets where ticket_id = 'T-2'`), [{ status: 'ready', model: 'opus' }])
  assert.match(prompts.join(), /the body/)
})

test('nothing is spawned while an implementer is running', async () => {
  // given
  // ... one ticket in progress with its implementer live, and one ready
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'in_progress', 'opus'), ('T-2', 'two', 'ready', 'sonnet')`)
  const { d, spawned } = deps(run, [live('pipeline T-1')])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... no agent is started and the ready ticket waits
  assert.deepEqual(spawned, [])
  assert.deepEqual(await sql(run, db, `select status from tickets where ticket_id = 'T-2'`), [{ status: 'ready' }])
})

test('a ticket whose implementer is gone without a result goes to needs_human', async () => {
  // given
  // ... a ticket in progress and no implementer live for it
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'in_progress', 'opus')`)
  const { d } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... it waits on a human, with a question saying why
  const [row] = await sql(run, db, `select status, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.match(String(row?.question), /stopped without recording/)
})

test('a refused spawn puts the ticket back to ready', async () => {
  // given
  // ... a ready ticket and spawns being refused
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'ready', 'sonnet')`)
  const { d } = deps(run, [], true)

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... the ticket is ready for the next pass and the refusal is logged
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'ready' }])
  assert.match(log.join('\n'), /T-1 not started: no verdict/)
})
