import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, ModelCompleteResult } from 'claude-code'
import { type Deps, pass } from '../src/loop.ts'
import { onReport } from '../pipeline-agents/src/result.ts'
import { type Run, lit, sql } from '../pipeline-agents/src/store.ts'
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
  await sql(run, db, `update tickets set difficulty = 5`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... the first ticket goes to the fable implementer, told to open a draft, and is in progress at stage implement
  assert.deepEqual(spawned.map(s => [s.description, s.subagentType]), [['pipeline T-1', 'pipeline:implementer-fable']])
  assert.match(spawned[0]?.prompt ?? '', /with the title prefix "Draft: "/)
  assert.deepEqual(await sql(run, db, `select ticket_id, status, stage from tickets order by rowid`), [
    { ticket_id: 'T-1', status: 'in_progress', stage: 'implement' },
    { ticket_id: 'T-2', status: 'ready', stage: null },
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
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('T-1', 'one', 'ready', 'sonnet', 1)`)
  const { d } = deps(run, [], true)

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... the ticket is ready for the next pass and the refusal is logged
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'ready' }])
  assert.match(log.join('\n'), /T-1 not started: no verdict/)
})

test('a difficulty 3+ ticket whose implementer reports a PR moves to review, and the next pass starts both reviewers one tier up', async () => {
  // given
  // ... a difficulty 3 opus ticket at stage implement and the default review threshold
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty) values ('T-1', 'one', 'in_progress', 'implement', 'opus', 3)`)
  const { d, spawned } = deps(run, [])

  // when
  // ... the implementer reports its draft PR through pipeline-agents, then the loop's pass runs with no agent live
  await onReport(run, 'pipeline', live('pipeline T-1'), { status: 'pr_open', pr_url: 'https://git/pr/1' })
  const before = spawned.length
  await pass(d)

  // then
  // ... the report started nothing; the pass started the spec and quality reviewers on fable with the PR in their prompt
  assert.equal(before, 0)
  assert.deepEqual(await sql(run, db, `select status, stage, started, pr_url from tickets`), [{ status: 'in_progress', stage: 'review', started: 1, pr_url: 'https://git/pr/1' }])
  assert.deepEqual(
    spawned.map(s => [s.description, s.subagentType, s.model]),
    [
      ['pipeline T-1 reviewer-spec', 'pipeline:reviewer-spec', 'fable'],
      ['pipeline T-1 reviewer-quality', 'pipeline:reviewer-quality', 'fable'],
    ],
  )
  assert.match(spawned[0]?.prompt ?? '', /PR: https:\/\/git\/pr\/1/)
})

test('a difficulty 1-2 ticket is told to open a normal PR and goes straight to pr_open', async () => {
  // given
  // ... a ready difficulty 2 sonnet ticket
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('T-1', 'one', 'ready', 'sonnet', 2)`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass starts its implementer, which then reports a PR
  await pass(d)
  await onReport(run, 'pipeline', live('pipeline T-1'), { status: 'pr_open', pr_url: 'https://git/pr/1' })

  // then
  // ... the implementer was told not to use the prefix, the ticket is pr_open and no reviewer started
  assert.match(spawned[0]?.prompt ?? '', /without a "Draft: " title prefix/)
  assert.deepEqual(spawned.map(s => s.description), ['pipeline T-1'])
  assert.deepEqual(await sql(run, db, `select status, pr_url from tickets`), [{ status: 'pr_open', pr_url: 'https://git/pr/1' }])
})

test('a review whose reviewers are done hands over to the verifier one tier up', async () => {
  // given
  // ... a sonnet ticket at stage review with no reviewer live
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', 'review', 'sonnet', 3, 'https://git/pr/1')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... the ticket is at stage verify and the verifier runs on opus
  assert.deepEqual(await sql(run, db, `select status, stage from tickets`), [{ status: 'in_progress', stage: 'verify' }])
  assert.deepEqual(spawned.map(s => [s.description, s.subagentType, s.model]), [['pipeline T-1 verifier', 'pipeline:verifier', 'opus']])
})

test('a review with a reviewer still live waits', async () => {
  // given
  // ... a ticket at stage review with one reviewer still running
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', 'review', 'opus', 3, 'https://git/pr/1')`)
  const { d, spawned } = deps(run, [live('pipeline T-1 reviewer-quality')])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... nothing is spawned and the ticket stays at review
  assert.deepEqual(spawned, [])
  assert.deepEqual(await sql(run, db, `select status, stage from tickets`), [{ status: 'in_progress', stage: 'review' }])
})

test('no implementer is spawned while a ticket is being verified', async () => {
  // given
  // ... a ticket at stage verify with its verifier live, and a ready ticket
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', 'verify', 'opus', 3, 'https://git/pr/1')`)
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('T-2', 'two', 'ready', 'sonnet', 1)`)
  const { d, spawned } = deps(run, [live('pipeline T-1 verifier')])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... no agent is started and the ready ticket waits
  assert.deepEqual(spawned, [])
  assert.deepEqual(await sql(run, db, `select status from tickets where ticket_id = 'T-2'`), [{ status: 'ready' }])
})

test('a ticket whose verifier is gone without a result goes to needs_human', async () => {
  // given
  // ... a ticket at stage verify and no agent live for it
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', 'verify', 'opus', 3, 'https://git/pr/1')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... it waits on a human, nothing is respawned, and the question names the verifier
  const [row] = await sql(run, db, `select status, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.match(String(row?.question), /The verifier stopped without recording a result/)
  assert.deepEqual(spawned, [])
  assert.match(log.join('\n'), /T-1 needs you: its verifier stopped/)
})

test('a database made before stages gains the column on the first pass and its rows read as implement', async () => {
  // given
  // ... a tickets table without stage, holding a ticket in progress whose implementer is gone
  const { run, db } = await freshProject()
  await sql(run, db, `drop table tickets; create table tickets (ticket_id text primary key, title text not null, url text, body text,
    status text not null default 'new', question text, difficulty integer, confidence real, model text, reason text, pr_url text,
    learned integer not null default 0); insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', 'in_progress', 'opus')`)

  // when
  // ... a pass runs
  await pass(deps(run, []).d)

  // then
  // ... the column exists, and the ticket was handled as an implementer gone without a result
  assert.deepEqual(await sql(run, db, `select stage, status from tickets`), [{ stage: null, status: 'needs_human' }])
  assert.match(String((await sql(run, db, `select question from tickets`))[0]?.question), /The implementer stopped/)
})
