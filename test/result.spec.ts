import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentInfo } from 'claude-code'
import { dbRefusal, report, stop } from '../pipeline-agents/src/result.ts'
import { sql } from '../pipeline-agents/src/store.ts'
import { freshDb, run } from './helpers.ts'

const implementer = { description: 'pipeline T-1', status: 'running', spawnedBy: 'pipeline' } as AgentInfo

const verifier = { ...implementer, description: 'pipeline T-1 verifier' } as AgentInfo
const fixer = { ...implementer, description: 'pipeline T-1 fixer' } as AgentInfo

/** A ticket T-1 at `status`, with `more` columns set (stage, difficulty, pr_url as SQL). */
const withTicket = async (status: string, more = '') => {
  const db = await freshDb()
  await sql(run, db, `insert into tickets (ticket_id, title, status, model) values ('T-1', 'one', '${status}', 'opus')`)
  if (more !== '') await sql(run, db, `update tickets set ${more}`)
  return db
}

const row = (db: string) => sql(run, db, `select status, pr_url, question from tickets`)

test('pr_open opens the ticket with its PR url and logs it', async () => {
  // given
  // ... a ticket in progress
  const db = await withTicket('in_progress')

  // when
  // ... its implementer reports the PR
  const r = await report(run, db, 'pipeline', implementer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... the ticket is pr_open with the url, and the change is logged
  assert.deepEqual(await row(db), [{ status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7', question: null }])
  assert.deepEqual(r, { log: 'T-1 has a PR: https://github.com/o/r/pull/7', changed: true, next: undefined })
})

test('blocked sends the ticket to needs_human with the question, apostrophes intact', async () => {
  // given
  // ... a ticket in progress
  const db = await withTicket('in_progress')

  // when
  // ... its implementer reports a question holding an apostrophe and SQL
  await report(run, db, 'pipeline', implementer, { status: 'blocked', question: "Should the hook use Dan's table'; drop table tickets; --?" }, 3)

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
  const r = await report(run, db, 'pipeline', implementer, { status: 'pr_open' }, 3)

  // then
  // ... the call is refused with the reason, which is logged, and the row is unchanged
  assert.deepEqual(r, { log: 'T-1 report_result refused: status pr_open needs pr_url', changed: false, deny: 'status pr_open needs pr_url' })
  assert.deepEqual(await row(db), [{ status: 'in_progress', pr_url: null, question: null }])
})

test('a call from an agent the plugin did not spawn as an implementer is refused', async () => {
  // given
  // ... a ticket in progress and an agent named like an implementer but spawned by someone else
  const db = await withTicket('in_progress')
  const stranger = { ...implementer, spawnedBy: 'other' } as AgentInfo

  // when
  // ... that agent reports a PR
  const r = await report(run, db, 'pipeline', stranger, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... the call is refused with the reason, which is logged against the agent, and the row is unchanged
  assert.equal(r.deny, 'report_result is only for the pipeline agents')
  assert.equal(r.log, 'pipeline T-1 report_result refused: report_result is only for the pipeline agents')
  assert.deepEqual(await row(db), [{ status: 'in_progress', pr_url: null, question: null }])
})

test('a report for a ticket no longer in progress leaves the row unchanged and logs that nothing changed', async () => {
  // given
  // ... a ticket the orphan rule already sent to a human
  const db = await withTicket('needs_human')

  // when
  // ... its implementer reports a PR
  const r = await report(run, db, 'pipeline', implementer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... the row is unchanged and the log says what was reported and the status it found
  assert.deepEqual(await row(db), [{ status: 'needs_human', pr_url: null, question: null }])
  assert.deepEqual(r, { log: 'T-1 reported a PR but was already needs_human; nothing changed', changed: false })
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

const staged = (db: string) => sql(run, db, `select status, stage, pr_url from tickets`)

test('an implementer of a ticket at or above the review threshold reporting a PR moves it to review', async () => {
  // given
  // ... a difficulty 3 ticket at stage implement, with the threshold at 3
  const db = await withTicket('in_progress', `stage = 'implement', difficulty = 3`)

  // when
  // ... its implementer reports the draft PR
  const r = await report(run, db, 'pipeline', implementer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... it stays in progress at stage review with the url, and the reviewers are to be started
  assert.deepEqual(await staged(db), [{ status: 'in_progress', stage: 'review', pr_url: 'https://github.com/o/r/pull/7' }])
  assert.equal(r?.next, 'review')
})

test('an implementer of a ticket below the review threshold reporting a PR opens it', async () => {
  // given
  // ... a difficulty 2 ticket at stage implement, with the threshold at 3
  const db = await withTicket('in_progress', `stage = 'implement', difficulty = 2`)

  // when
  // ... its implementer reports the PR
  const r = await report(run, db, 'pipeline', implementer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... the ticket is pr_open and nothing is to be started
  assert.deepEqual(await staged(db), [{ status: 'pr_open', stage: 'implement', pr_url: 'https://github.com/o/r/pull/7' }])
  assert.equal(r?.next, undefined)
})

test('a verifier reporting 0 findings opens the PR', async () => {
  // given
  // ... a ticket at stage verify with its draft PR
  const db = await withTicket('in_progress', `stage = 'verify', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)

  // when
  // ... its verifier reports no findings
  const r = await report(run, db, 'pipeline', verifier, { status: 'reviewed', findings: 0 }, 3)

  // then
  // ... the ticket is pr_open with its url kept, and no fixer is to be started
  assert.deepEqual(await staged(db), [{ status: 'pr_open', stage: 'verify', pr_url: 'https://github.com/o/r/pull/7' }])
  assert.equal(r?.next, undefined)
})

test('a verifier reporting findings moves the ticket to fix', async () => {
  // given
  // ... a ticket at stage verify with its draft PR
  const db = await withTicket('in_progress', `stage = 'verify', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)

  // when
  // ... its verifier reports two findings
  const r = await report(run, db, 'pipeline', verifier, { status: 'reviewed', findings: 2 }, 3)

  // then
  // ... the ticket stays in progress at stage fix, and the fixer is to be started
  assert.deepEqual(await staged(db), [{ status: 'in_progress', stage: 'fix', pr_url: 'https://github.com/o/r/pull/7' }])
  assert.equal(r?.next, 'fix')
})

test('a fixer reporting the PR opens it', async () => {
  // given
  // ... a ticket at stage fix
  const db = await withTicket('in_progress', `stage = 'fix', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)

  // when
  // ... its fixer reports the PR
  const r = await report(run, db, 'pipeline', fixer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... the ticket is pr_open, not sent back to review
  assert.deepEqual(await staged(db), [{ status: 'pr_open', stage: 'fix', pr_url: 'https://github.com/o/r/pull/7' }])
  assert.equal(r?.next, undefined)
})

test('a blocked fixer sends the ticket to needs_human with its question', async () => {
  // given
  // ... a ticket at stage fix
  const db = await withTicket('in_progress', `stage = 'fix', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)

  // when
  // ... its fixer reports blocked
  await report(run, db, 'pipeline', fixer, { status: 'blocked', question: 'Which finding wins?' }, 3)

  // then
  // ... the ticket waits on a human with the question
  assert.deepEqual(await row(db), [{ status: 'needs_human', pr_url: 'https://github.com/o/r/pull/7', question: 'Which finding wins?' }])
})

test('a report from an agent whose stage the ticket has left is not recorded', async () => {
  // given
  // ... a ticket already at stage fix
  const db = await withTicket('in_progress', `stage = 'fix', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)

  // when
  // ... its verifier reports again
  const r = await report(run, db, 'pipeline', verifier, { status: 'reviewed', findings: 0 }, 3)

  // then
  // ... nothing changed and the log names the stage found
  assert.equal(r.changed, false)
  assert.equal(r.log, 'T-1 reported no findings but was already in_progress at fix; nothing changed')
  assert.deepEqual(await staged(db), [{ status: 'in_progress', stage: 'fix', pr_url: 'https://github.com/o/r/pull/7' }])
})

test('a reviewer calling report_result is refused', async () => {
  // given
  // ... a ticket at stage review
  const db = await withTicket('in_progress', `stage = 'review', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)
  const reviewer = { ...implementer, description: 'pipeline T-1 reviewer-spec' } as AgentInfo

  // when
  // ... a reviewer reports a PR
  const r = await report(run, db, 'pipeline', reviewer, { status: 'pr_open', pr_url: 'https://github.com/o/r/pull/7' }, 3)

  // then
  // ... the call is refused and the row is unchanged
  assert.match(String(r.deny), /reviewers post their findings/)
  assert.deepEqual(await staged(db), [{ status: 'in_progress', stage: 'review', pr_url: 'https://github.com/o/r/pull/7' }])
})

test('a reviewer may stop without reporting', async () => {
  // given
  // ... a ticket at stage review
  const db = await withTicket('in_progress', `stage = 'review', difficulty = 4, pr_url = 'https://github.com/o/r/pull/7'`)
  const reviewer = { ...implementer, description: 'pipeline T-1 reviewer-quality' } as AgentInfo

  // when
  // ... a reviewer stops
  const s = await stop(run, db, 'pipeline', reviewer, false)

  // then
  // ... it is neither blocked nor logged
  assert.deepEqual(s, {})
})

test('a pipeline agent writing pipeline.db with sqlite3 is refused and pointed at report_result', () => {
  // given
  // ... a verifier's Bash command that writes pipeline.db
  const input = { command: `sqlite3 .claude/pipeline/pipeline.db "update tickets set status = 'pr_open'"` }

  // when
  // ... the call is checked
  const deny = dbRefusal(verifier, 'pipeline', 'Bash', input)

  // then
  // ... it is refused with a reason naming report_result
  assert.match(String(deny), /report_result/)
})

test('a pipeline agent writing tracker.db runs', () => {
  // given
  // ... an implementer's Bash command that moves the tracker status
  const input = { command: `sqlite3 .claude/pipeline/tracker.db "update tickets set status = 'in_review' where id = 1"` }

  // when
  // ... the call is checked
  const deny = dbRefusal(implementer, 'pipeline', 'Bash', input)

  // then
  // ... it runs
  assert.equal(deny, undefined)
})

test('an agent the pipeline did not spawn may touch pipeline.db', () => {
  // given
  // ... another plugin's agent, described like a pipeline agent, reading pipeline.db
  const other = { ...implementer, spawnedBy: 'other' } as AgentInfo
  const input = { command: 'sqlite3 .claude/pipeline/pipeline.db "select * from tickets"' }

  // when
  // ... the call is checked
  const deny = dbRefusal(other, 'pipeline', 'Bash', input)

  // then
  // ... it runs
  assert.equal(deny, undefined)
})

test('a pipeline agent reading pipeline.db with a tool other than Bash runs', () => {
  // given
  // ... an implementer's Read of pipeline.db
  const input = { file_path: '/repo/.claude/pipeline/pipeline.db' }

  // when
  // ... the call is checked
  const deny = dbRefusal(implementer, 'pipeline', 'Read', input)

  // then
  // ... it runs
  assert.equal(deny, undefined)
})
