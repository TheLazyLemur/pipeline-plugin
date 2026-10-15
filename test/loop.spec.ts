import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, ModelCompleteResult } from 'claude-code'
import { type Deps, pass } from '../src/loop.ts'
import { onReport } from '../pipeline-agents/src/result.ts'
import { type Run, lit, sql } from '../pipeline-agents/src/store.ts'
import type { Tracker } from '../src/sync.ts'
import { emptyTracker, fakeTracker, freshProject } from './helpers.ts'

const live = (description: string) => ({ description, status: 'running', spawnedBy: 'pipeline' }) as AgentInfo

/** Deps over a project for session `session` with an empty tracker, recording every spawn; `refuse` denies them all; `paths` are the main checkout and home, fake unless a test needs them. */
const deps = (run: Run, agents: AgentInfo[], refuse = false, session = 's1', paths = { root: '/project', home: '/home/u' }) => {
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
    session,
    ...paths,
    tracker: emptyTracker(),
  }
  return { d, spawned }
}

/** A tracker tool over a SQLite tracker in the project root: `todo` tickets wait, `links` hold "blocked by", `merged` are the merged PR URLs. */
const sqliteTracker = async (run: Run, fill: string, merged: string[]): Promise<Tracker> => {
  await sql(run, 'tracker.db', `create table tickets (id integer primary key, status text not null);
    create table links (ticket_id integer not null, blocked_by integer not null);
    ${fill}`)
  return fakeTracker({
    waiting: () => sql(run, 'tracker.db', `select id, 't' || id as title, null as url, null as body from tickets where status = 'todo'`),
    done: () => sql(run, 'tracker.db', `select id from tickets where status = 'done'`),
    blockers: () => sql(run, 'tracker.db', `select l.ticket_id as id, l.blocked_by, b.status = 'done' as blocker_done from links l join tickets b on b.id = l.blocked_by`),
    pr_merged: ({ url }) => ({ merged: merged.includes(String(url)) }),
    mark_done: async ({ id }) => sql(run, 'tracker.db', `update tickets set status = 'done' where id = ${lit(String(id))} returning id`),
  })
}

/** Deps over the project whose tracker is `tracker`. */
const tracked = (run: Run, tracker: Tracker, paths?: { root: string; home: string }) => {
  const made = deps(run, [], false, 's1', paths)
  made.d.tracker = tracker
  return made
}

test('a merged PR marks its ticket done in the tracker and the table', async () => {
  // given
  // ... a ticket with its PR open and merged
  const { run, db } = await freshProject()
  const tracker = await sqliteTracker(run, `insert into tickets values (1, 'in_review');`, ['https://git/pr/1'])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)

  // when
  // ... a pass runs
  const log = await pass(tracked(run, tracker).d)

  // then
  // ... it is done in both, and the pass says so
  assert.deepEqual(await sql(run, 'tracker.db', `select status from tickets`), [{ status: 'done' }])
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'done' }])
  assert.match(log.join('\n'), /1 is done: its PR merged/)
})

test('an unmerged PR leaves its ticket open in the tracker and the table', async () => {
  // given
  // ... a ticket with its PR open and not merged
  const { run, db } = await freshProject()
  const tracker = await sqliteTracker(run, `insert into tickets values (1, 'in_review');`, [])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)

  // when
  // ... a pass runs
  await pass(tracked(run, tracker).d)

  // then
  // ... it is still in review and pr_open
  assert.deepEqual(await sql(run, 'tracker.db', `select status from tickets`), [{ status: 'in_review' }])
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'pr_open' }])
})

test('a dependent of a ticket whose PR just merged is pulled in and started in the same pass', async () => {
  // given
  // ... ticket 2 waiting, blocked by ticket 1 whose PR has merged
  const { run, db } = await freshProject()
  const tracker = await sqliteTracker(run, `insert into tickets values (1, 'in_review'), (2, 'todo'); insert into links values (2, 1);`, ['https://git/pr/1'])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)
  const { d, spawned } = tracked(run, tracker)

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

test('a project without a tracker tool is told to run /tracker-setup, and the rest of the pass runs', async () => {
  // given
  // ... no tracker tool, a ticket whose PR is open, and a ready ticket
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('2', 'two', 'ready', 'sonnet', 1)`)
  const { d, spawned } = deps(run, [])
  d.tracker = null

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... it says what to run, skips the merge check, and still starts the ready ticket's implementer
  assert.match(log.join('\n'), /no pipeline tracker tool here; run \/tracker-setup/)
  assert.deepEqual(await sql(run, db, `select ticket_id, status from tickets order by rowid`), [
    { ticket_id: '1', status: 'pr_open' },
    { ticket_id: '2', status: 'in_progress' },
  ])
  assert.deepEqual(spawned.map(s => s.description), ['pipeline 2'])
})

test('a tracker error is logged and the stage step still spawns the verifier', async () => {
  // given
  // ... a ticket at stage verify whose verifier is still to be started, and a tracker whose every op fails
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, started, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', 'verify', 0, 'sonnet', 3, 'https://git/pr/1')`)
  const { d, spawned } = tracked(run, async op => {
    throw new Error(`tracker ${op} failed: timed out after 30 s`)
  })

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... the pass logs the tracker unreachable and still starts the verifier
  assert.match(log.join('\n'), /tracker unreachable: tracker waiting failed: timed out after 30 s/)
  assert.deepEqual(spawned.map(s => s.description), ['pipeline T-1 verifier'])
  assert.deepEqual(await sql(run, db, `select stage, started from tickets`), [{ stage: 'verify', started: 1 }])
})

test('a merge check that does not answer {merged: true|false} is refused and the ticket stays open', async () => {
  // given
  // ... a ticket whose PR is open, and a tracker whose pr_merged answers a bare string
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)
  const { d } = tracked(run, fakeTracker({ pr_merged: () => 'yes', mark_done: () => 'ok' }))

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... the pass logs the bad answer as the tracker unreachable, and the ticket is still pr_open
  assert.match(log.join('\n'), /tracker unreachable: tracker pr_merged returned "yes" for https:\/\/git\/pr\/1, not \{"merged": true\|false\}/)
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'pr_open' }])
})

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
  // ... the first ticket goes to the fable implementer, told to open a draft and where its worktree is, and is in progress at stage implement
  assert.deepEqual(spawned.map(s => [s.description, s.subagentType]), [['pipeline T-1', 'pipeline:implementer-fable']])
  assert.match(spawned[0]?.prompt ?? '', /`pr_create` with `draft: true`/)
  assert.match(spawned[0]?.prompt ?? '', /^Worktree: \/home\/u\/\.claude\/pipeline-worktrees\/project\/T-1-implementer$/m)
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
  d.complete = r => {
    assert(typeof r.prompt === 'string')
    prompts.push(r.prompt)
    return complete(r)
  }

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

test('a ticket whose implementer is gone without a result goes to needs_human, not restarted', async () => {
  // given
  // ... a ticket at stage implement that was never restarted, and no implementer live for it
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model) values ('T-1', 'one', 'in_progress', 'implement', 'opus')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  await pass(d)

  // then
  // ... it waits on a human, with a question saying why, and nothing is spawned
  const [row] = await sql(run, db, `select status, restarts, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.equal(row?.restarts, 0)
  assert.match(String(row?.question), /stopped without recording/)
  assert.deepEqual(spawned, [])
})

test('a refused spawn puts the ticket back to ready, unowned', async () => {
  // given
  // ... a ready ticket and spawns being refused
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('T-1', 'one', 'ready', 'sonnet', 1)`)
  const { d } = deps(run, [], true)

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... the ticket is ready for the next pass with no claim left on it, and the refusal is logged
  assert.deepEqual(await sql(run, db, `select status, owner, owner_seen from tickets`), [{ status: 'ready', owner: null, owner_seen: null }])
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
  assert.match(spawned[0]?.prompt ?? '', /^Worktree: \/home\/u\/\.claude\/pipeline-worktrees\/project\/T-1-reviewer-spec$/m)
})

test('a ticket whose PR merged has its leftover worktrees removed, and another ticket keeps its own', async () => {
  // given
  // ... the project is a git repository, ticket 1's PR has merged, and worktrees of ticket 1's fixer and ticket 2's implementer are left under the worktree root
  const { run, db, root } = await freshProject()
  const tracker = await sqliteTracker(run, `insert into tickets values (1, 'in_review'), (2, 'in_review');`, ['https://git/pr/1'])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1'), ('2', 'two', 'pr_open', 'https://git/pr/2')`)
  for (const argv of [['git', 'init', '-q'], ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root']]) assert.equal((await run(argv)).exitCode, 0, argv.join(' '))
  const home = mkdtempSync(join(tmpdir(), 'pipeline-home-'))
  const left = join(home, '.claude/pipeline-worktrees', basename(root), '1-fixer')
  const other = join(home, '.claude/pipeline-worktrees', basename(root), '2-implementer')
  for (const path of [left, other]) assert.equal((await run(['git', 'worktree', 'add', '-q', '--detach', path])).exitCode, 0)
  writeFileSync(join(left, 'dirty.txt'), 'uncommitted')

  // when
  // ... a pass runs
  const log = await pass(tracked(run, tracker, { root, home }).d)

  // then
  // ... ticket 1's worktree is gone from disk and from git, ticket 2's stands, and the pass says what it removed
  assert.equal(existsSync(left), false)
  assert.equal(existsSync(other), true)
  assert.doesNotMatch((await run(['git', 'worktree', 'list'])).stdout, /1-fixer/)
  assert.match((await run(['git', 'worktree', 'list'])).stdout, /2-implementer/)
  assert.match(log.join('\n'), /1 fixer left a worktree; removed /)
})

test('a ticket marked done in the tracker has its leftover worktree removed', async () => {
  // given
  // ... the project is a git repository, ticket 1 is done in the tracker (its PR unmerged) and pr_open in the table, and its verifier left a worktree
  const { run, db, root } = await freshProject()
  const tracker = await sqliteTracker(run, `insert into tickets values (1, 'done');`, [])
  await sql(run, db, `insert into tickets (ticket_id, title, status, pr_url) values ('1', 'one', 'pr_open', 'https://git/pr/1')`)
  for (const argv of [['git', 'init', '-q'], ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root']]) assert.equal((await run(argv)).exitCode, 0, argv.join(' '))
  const home = mkdtempSync(join(tmpdir(), 'pipeline-home-'))
  const left = join(home, '.claude/pipeline-worktrees', basename(root), '1-verifier')
  assert.equal((await run(['git', 'worktree', 'add', '-q', '--detach', left])).exitCode, 0)

  // when
  // ... a pass runs
  const log = await pass(tracked(run, tracker, { root, home }).d)

  // then
  // ... the ticket is done in the table and its worktree is gone
  assert.deepEqual(await sql(run, db, `select status from tickets`), [{ status: 'done' }])
  assert.equal(existsSync(left), false)
  assert.match(log.join('\n'), /1 verifier left a worktree; removed /)
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
  // ... the implementer was told to open a normal PR, the ticket is pr_open and no reviewer started
  assert.match(spawned[0]?.prompt ?? '', /`pr_create` with `draft: false`/)
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

for (const [stage, role, model] of [
  ['verify', 'verifier', 'opus'],
  ['fix', 'fixer', 'sonnet'],
] as const) {
  test(`a ticket whose ${role} is gone without a result for the first time has it started again`, async () => {
    // given
    // ... a sonnet ticket at stage ${stage}, never restarted, and no agent live for it
    const { run, db } = await freshProject()
    await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', ${lit(stage)}, 'sonnet', 3, 'https://git/pr/1')`)
    const { d, spawned } = deps(run, [])

    // when
    // ... a pass runs
    const log = await pass(d)

    // then
    // ... the ${role} is spawned again, the ticket is marked restarted, and the pass says so
    assert.deepEqual(spawned.map(s => [s.description, s.model]), [[`pipeline T-1 ${role}`, model]])
    assert.deepEqual(await sql(run, db, `select status, stage, started, restarts from tickets`), [{ status: 'in_progress', stage, started: 1, restarts: 1 }])
    assert.match(log.join('\n'), new RegExp(`T-1 ${role} vanished; restarting it once`))
  })
}

test('a ticket whose verifier is gone without a result a second time goes to needs_human', async () => {
  // given
  // ... a ticket at stage verify already restarted once, and no agent live for it
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, restarts, model, difficulty, pr_url) values ('T-1', 'one', 'in_progress', 'verify', 1, 'opus', 3, 'https://git/pr/1')`)
  const { d, spawned } = deps(run, [])

  // when
  // ... a pass runs
  const log = await pass(d)

  // then
  // ... it waits on a human with restarts back at 0, nothing is respawned, and the question names the verifier
  const [row] = await sql(run, db, `select status, restarts, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.equal(row?.restarts, 0)
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
  // ... the columns exist, and the ticket was adopted and handled as an implementer gone without a result
  assert.deepEqual(await sql(run, db, `select stage, restarts, status, owner, owner_seen is not null as seen from tickets`), [{ stage: null, restarts: 0, status: 'needs_human', owner: 's1', seen: 1 }])
  assert.match(String((await sql(run, db, `select question from tickets`))[0]?.question), /The implementer stopped/)
})

test('two passes racing for one ready ticket spawn one implementer', async () => {
  // given
  // ... one ready ticket, and session s1 whose claim runs only after session s2's whole pass has run
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('T-1', 'one', 'ready', 'sonnet', 1)`)
  const s2 = deps(run, [], false, 's2')
  let raced = false
  const racing: Run = async (argv, init) => {
    if (!raced && argv.some(a => a.includes("set status = 'in_progress'"))) {
      raced = true
      await pass(s2.d)
    }
    return run(argv, init)
  }
  const s1 = deps(racing, [])

  // when
  // ... s1 runs a pass, s2 claiming the ticket between s1's select and s1's claim
  await pass(s1.d)

  // then
  // ... only s2 spawned an implementer, and the ticket is s2's
  assert.deepEqual(s1.spawned, [])
  assert.deepEqual(s2.spawned.map(s => s.description), ['pipeline T-1'])
  assert.deepEqual(await sql(run, db, `select status, owner from tickets`), [{ status: 'in_progress', owner: 's2' }])
})

test("another session's ticket whose owner was seen recently is left alone and holds the next ready one", async () => {
  // given
  // ... a ticket of session s2 at stage review seen a minute ago, a ready ticket, and no agent live in session s1
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, difficulty, pr_url, owner, owner_seen)
    values ('T-1', 'one', 'in_progress', 'review', 'opus', 3, 'https://git/pr/1', 's2', datetime('now', '-1 minute'))`)
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, difficulty) values ('T-2', 'two', 'ready', 'sonnet', 1)`)
  const { d, spawned } = deps(run, [])

  // when
  // ... s1 runs a pass
  await pass(d)

  // then
  // ... nothing is spawned, s2's ticket stays at review with s2, and the ready ticket waits
  assert.deepEqual(spawned, [])
  assert.deepEqual(await sql(run, db, `select ticket_id, status, stage, owner from tickets order by rowid`), [
    { ticket_id: 'T-1', status: 'in_progress', stage: 'review', owner: 's2' },
    { ticket_id: 'T-2', status: 'ready', stage: null, owner: null },
  ])
})

test('a ticket whose owning session has not been seen for 15 minutes goes to needs_human', async () => {
  // given
  // ... a ticket of session s2 last seen 16 minutes ago
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, stage, model, owner, owner_seen)
    values ('T-1', 'one', 'in_progress', 'implement', 'opus', 's2', datetime('now', '-16 minutes'))`)

  // when
  // ... session s1 runs a pass
  const log = await pass(deps(run, []).d)

  // then
  // ... it waits on a human, with a question saying its owning session stopped
  const [row] = await sql(run, db, `select status, question from tickets`)
  assert.equal(row?.status, 'needs_human')
  assert.match(String(row?.question), /The session that owned this ticket \(s2\) stopped/)
  assert.match(log.join('\n'), /T-1 needs you: its owning session stopped/)
})

test('a pass stamps owner_seen on the tickets its session owns', async () => {
  // given
  // ... a ticket of session s1 last seen 10 minutes ago, with its implementer live
  const { run, db } = await freshProject()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model, owner, owner_seen)
    values ('T-1', 'one', 'in_progress', 'opus', 's1', datetime('now', '-10 minutes'))`)

  // when
  // ... s1 runs a pass
  await pass(deps(run, [live('pipeline T-1')]).d)

  // then
  // ... it was seen within the last minute and is still in progress
  assert.deepEqual(await sql(run, db, `select status, owner_seen > datetime('now', '-1 minute') as fresh from tickets`), [{ status: 'in_progress', fresh: 1 }])
})
