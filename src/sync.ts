import { type Run, lit, sql } from '../pipeline-agents/src/store.ts'

/** The headings in tracker.md whose first fenced block is a shell command printing a JSON array. */
export const WAITING = 'List the tickets waiting to be worked'
export const DONE = 'List the tickets that are done'
export const BLOCKERS = 'List the blockers'
/** The headings whose command takes one value as `$1`: a PR URL, then a tracker ticket id. */
export const MERGED = 'Check whether a PR is merged'
export const MARK_DONE = 'Mark a ticket done'

type Row = Record<string, unknown>

const command = (tracker: string, heading: string) => {
  const section = tracker.split(/^## /m).find(s => s.startsWith(`${heading}\n`))
  const block = section?.match(/^```[^\n]*\n([\s\S]*?)^```/m)?.[1]
  if (block === undefined || block.trim() === '') throw new Error(`tracker.md has no command under "## ${heading}"; run /tracker-setup`)
  return block
}

/** Runs one tracker.md command; empty output is no rows (`sqlite3 -json` prints nothing for none). */
const list = async (run: Run, tracker: string, heading: string): Promise<Row[]> => {
  const r = await run(['sh', '-c', command(tracker, heading)])
  if (r.exitCode !== 0) throw new Error(`"${heading}" exited ${r.exitCode}: ${r.stderr.trim()}`)
  const rows: unknown = r.stdout.trim() === '' ? [] : JSON.parse(r.stdout)
  if (!Array.isArray(rows) || !rows.every(row => typeof row === 'object' && row !== null)) throw new Error(`"${heading}" did not print a JSON array of objects`)
  return rows
}

/** Runs one tracker.md command with `value` as its `$1`, so the value is never read as shell text. */
const call = async (run: Run, cmd: string, heading: string, value: string) => {
  const r = await run(['sh', '-c', cmd, 'sh', value])
  if (r.exitCode !== 0) throw new Error(`"${heading}" exited ${r.exitCode} for ${value}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** Marks done, in the tracker and the table, every pr_open ticket whose PR has merged, so sync can release its dependents. Resolves the ids marked. */
export const closeMerged = async (run: Run, db: string, tracker: string): Promise<string[]> => {
  // both are looked up first, so a tracker.md without them fails even when no PR is open
  const [merged, markDone] = [command(tracker, MERGED), command(tracker, MARK_DONE)]
  const open = await sql(run, db, `select ticket_id, pr_url from tickets where status = 'pr_open' order by rowid`)
  const closed: string[] = []
  for (const t of open) {
    const ticket = String(t.ticket_id)
    if (typeof t.pr_url !== 'string') throw new Error(`${ticket} is pr_open with no pr_url`)
    const out = await call(run, merged, MERGED, t.pr_url)
    let answer = ''
    try {
      answer = JSON.stringify(JSON.parse(out))
    } catch {}
    if (answer !== '{"merged":true}' && answer !== '{"merged":false}') throw new Error(`"${MERGED}" printed ${JSON.stringify(out.slice(0, 200))} for ${t.pr_url}, not {"merged": true|false}`)
    if (answer === '{"merged":false}') continue
    await call(run, markDone, MARK_DONE, ticket)
    await sql(run, db, `update tickets set status = 'done' where ticket_id = ${lit(ticket)} and status = 'pr_open'`)
    closed.push(ticket)
  }
  return closed
}

const bad = (heading: string, row: Row, field: string): never => {
  throw new Error(`"${heading}" printed a row with a bad ${field}: ${JSON.stringify(row)}`)
}

/** Tracker ids are strings or integers; the pipeline stores them as text. */
const id = (heading: string, row: Row, field = 'id') => {
  const v = row[field]
  if ((typeof v === 'string' && v !== '') || Number.isInteger(v)) return String(v)
  return bad(heading, row, field)
}

/** Pulls the tracker into the pipeline table, following the three commands in tracker.md, in one transaction. */
export const sync = async (run: Run, db: string, tracker: string) => {
  const [waiting, done, blockers] = await Promise.all([list(run, tracker, WAITING), list(run, tracker, DONE), list(run, tracker, BLOCKERS)])

  const blocked = new Set<string>()
  for (const b of blockers) {
    id(BLOCKERS, b, 'blocked_by')
    if (![true, false, 0, 1].includes(b.blocker_done as never)) bad(BLOCKERS, b, 'blocker_done')
    if (!b.blocker_done) blocked.add(id(BLOCKERS, b))
  }

  const statements = ['begin;']
  for (const t of waiting) {
    const ticket = id(WAITING, t)
    if (typeof t.title !== 'string') bad(WAITING, t, 'title')
    if (typeof t.url !== 'string' && t.url !== null) bad(WAITING, t, 'url')
    if (typeof t.body !== 'string' && t.body !== null) bad(WAITING, t, 'body')
    if (blocked.has(ticket)) continue
    statements.push(`insert into tickets (ticket_id, title, url, body) values (${lit(ticket)}, ${lit(t.title as string)}, ${lit(t.url as string | null)}, ${lit(t.body as string | null)})
      on conflict (ticket_id) do update set title = excluded.title, url = excluded.url, body = excluded.body;`)
  }
  // a ticket that became blocked leaves until its blockers are done, unless work on it has started
  for (const ticket of blocked) statements.push(`delete from tickets where ticket_id = ${lit(ticket)} and status in ('new', 'ready');`)
  for (const t of done) statements.push(`update tickets set status = 'done', restarts = 0 where ticket_id = ${lit(id(DONE, t))};`)
  statements.push('commit;')
  await sql(run, db, statements.join('\n'))
}
