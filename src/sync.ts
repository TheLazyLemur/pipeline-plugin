import { type Run, lit, sql } from './store.ts'

/** The headings in tracker.md whose first fenced block is a shell command printing a JSON array. */
export const WAITING = 'List the tickets waiting to be worked'
export const DONE = 'List the tickets that are done'
export const BLOCKERS = 'List the blockers'

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
    if (blocked.has(ticket)) continue
    statements.push(`insert into tickets (ticket_id, title, url) values (${lit(ticket)}, ${lit(t.title as string)}, ${lit(t.url as string | null)})
      on conflict (ticket_id) do update set title = excluded.title, url = excluded.url;`)
  }
  // a ticket that became blocked leaves until its blockers are done, unless work on it has started
  for (const ticket of blocked) statements.push(`delete from tickets where ticket_id = ${lit(ticket)} and status in ('new', 'ready');`)
  for (const t of done) statements.push(`update tickets set status = 'done' where ticket_id = ${lit(id(DONE, t))};`)
  statements.push('commit;')
  await sql(run, db, statements.join('\n'))
}
