import { type Run, lit, sql } from '../pipeline-agents/src/store.ts'

/** The tool a project's `pipeline-tracker` mod registers (written by /tracker-setup), reaching its tracker and PR host. */
export const TRACKER_TOOL = 'mcp__pipeline-tracker__tracker'

/** One call of the tracker tool: `op` and its arguments in, the op's result out; rejects with the reason the op failed. */
export type Tracker = (op: string, args?: Record<string, unknown>) => Promise<unknown>

type Row = Record<string, unknown>

/** Calls one op that returns a list of rows. */
const list = async (tracker: Tracker, op: string): Promise<Row[]> => {
  const rows = await tracker(op)
  if (!Array.isArray(rows) || !rows.every(row => typeof row === 'object' && row !== null)) throw new Error(`tracker ${op} did not return an array of objects: ${JSON.stringify(rows)?.slice(0, 200)}`)
  return rows
}

/** Marks done, in the tracker and the table, every pr_open ticket whose PR has merged, so sync can release its dependents. Resolves the ids marked. */
export const closeMerged = async (tracker: Tracker, run: Run, db: string): Promise<string[]> => {
  const open = await sql(run, db, `select ticket_id, pr_url from tickets where status = 'pr_open' order by rowid`)
  const closed: string[] = []
  for (const t of open) {
    const ticket = String(t.ticket_id)
    if (typeof t.pr_url !== 'string') throw new Error(`${ticket} is pr_open with no pr_url`)
    const answer = JSON.stringify(await tracker('pr_merged', { url: t.pr_url }))
    if (answer !== '{"merged":true}' && answer !== '{"merged":false}') throw new Error(`tracker pr_merged returned ${answer?.slice(0, 200)} for ${t.pr_url}, not {"merged": true|false}`)
    if (answer === '{"merged":false}') continue
    await tracker('mark_done', { id: ticket })
    await sql(run, db, `update tickets set status = 'done' where ticket_id = ${lit(ticket)} and status = 'pr_open'`)
    closed.push(ticket)
  }
  return closed
}

const bad = (op: string, row: Row, field: string): never => {
  throw new Error(`tracker ${op} returned a row with a bad ${field}: ${JSON.stringify(row)}`)
}

/** Tracker ids are strings or integers; the pipeline stores them as text. */
const id = (op: string, row: Row, field = 'id') => {
  const v = row[field]
  if ((typeof v === 'string' && v !== '') || Number.isInteger(v)) return String(v)
  return bad(op, row, field)
}

/** Pulls the tracker into the pipeline table, from the tracker's `waiting`, `done` and `blockers` ops, in one transaction. Resolves the ids it marked done. */
export const sync = async (tracker: Tracker, run: Run, db: string): Promise<string[]> => {
  const [waiting, done, blockers] = await Promise.all([list(tracker, 'waiting'), list(tracker, 'done'), list(tracker, 'blockers')])

  const blocked = new Set<string>()
  for (const b of blockers) {
    id('blockers', b, 'blocked_by')
    if (![true, false, 0, 1].includes(b.blocker_done as never)) bad('blockers', b, 'blocker_done')
    if (!b.blocker_done) blocked.add(id('blockers', b))
  }

  const statements = ['begin;']
  for (const t of waiting) {
    const ticket = id('waiting', t)
    if (typeof t.title !== 'string') bad('waiting', t, 'title')
    if (typeof t.url !== 'string' && t.url !== null) bad('waiting', t, 'url')
    if (typeof t.body !== 'string' && t.body !== null) bad('waiting', t, 'body')
    if (blocked.has(ticket)) continue
    statements.push(`insert into tickets (ticket_id, title, url, body) values (${lit(ticket)}, ${lit(t.title as string)}, ${lit(t.url as string | null)}, ${lit(t.body as string | null)})
      on conflict (ticket_id) do update set title = excluded.title, url = excluded.url, body = excluded.body;`)
  }
  // a ticket that became blocked leaves until its blockers are done, unless work on it has started
  for (const ticket of blocked) statements.push(`delete from tickets where ticket_id = ${lit(ticket)} and status in ('new', 'ready');`)
  const ids = done.map(t => id('done', t))
  for (const ticket of ids) statements.push(`update tickets set status = 'done', restarts = 0 where ticket_id = ${lit(ticket)};`)
  statements.push('commit;')
  // read before the write: sqlite3 -json prints one array per statement, so a returning inside the transaction would not parse
  const marked = ids.length === 0 ? [] : await sql(run, db, `select ticket_id from tickets where status != 'done' and ticket_id in (${ids.map(lit).join(', ')})`)
  await sql(run, db, statements.join('\n'))
  return marked.map(r => String(r.ticket_id))
}
