import { type Run, lit, sql } from '../pipeline-agents/src/store.ts'

/** The headings in tracker.md whose first fenced block is a shell command printing a JSON array. */
export const WAITING = 'List the tickets waiting to be worked'
export const DONE = 'List the tickets that are done'
export const BLOCKERS = 'List the blockers'
/** The headings whose command takes one value as `$1`: a PR URL, then a tracker ticket id. */
export const MERGED = 'Check whether a PR is merged'
export const MARK_DONE = 'Mark a ticket done'
/** With stacking on: instructions the agents follow, then a command taking a PR URL as `$1`. */
export const STACK = 'Open a stacked PR'
export const RESTACK = 'Bring a stacked PR up to date'

type Row = Record<string, unknown>

const section = (tracker: string, heading: string) => tracker.split(/^## /m).find(s => s.startsWith(`${heading}\n`))?.slice(heading.length)

const command = (tracker: string, heading: string) => {
  const block = section(tracker, heading)?.match(/^```[^\n]*\n([\s\S]*?)^```/m)?.[1]
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

/** Frees the tickets stacked on `ticket`, which is done: the host retargets their PRs, so each is an ordinary PR. */
const unstack = (ticket: string) => `update tickets set stacked_on = null where stacked_on = ${lit(ticket)};`

const ANSWERS = ['{"merged":true}', '{"merged":false}', '{"merged":false,"closed":true}']

/**
 * Marks done, in the tracker and the table, every pr_open ticket whose PR has merged, so sync can release its
 * dependents; sends one whose PR was closed unmerged to needs_human, with every ticket stacked on it. Resolves the
 * ids marked done and what to log.
 */
export const closeMerged = async (run: Run, db: string, tracker: string): Promise<{ done: string[]; log: string[] }> => {
  // both are looked up first, so a tracker.md without them fails even when no PR is open
  const [merged, markDone] = [command(tracker, MERGED), command(tracker, MARK_DONE)]
  const open = await sql(run, db, `select ticket_id, pr_url from tickets where status = 'pr_open' order by rowid`)
  const done: string[] = []
  const log: string[] = []
  for (const t of open) {
    const ticket = String(t.ticket_id)
    if (typeof t.pr_url !== 'string') throw new Error(`${ticket} is pr_open with no pr_url`)
    const out = await call(run, merged, MERGED, t.pr_url)
    let answer = ''
    try {
      answer = JSON.stringify(JSON.parse(out))
    } catch {}
    if (!ANSWERS.includes(answer)) throw new Error(`"${MERGED}" printed ${JSON.stringify(out.slice(0, 200))} for ${t.pr_url}, not {"merged": true|false} or {"merged": false, "closed": true}`)
    if (answer === '{"merged":false}') continue
    if (answer === '{"merged":true}') {
      await call(run, markDone, MARK_DONE, ticket)
      await sql(run, db, `update tickets set status = 'done' where ticket_id = ${lit(ticket)} and status = 'pr_open'; ${unstack(ticket)}`)
      done.push(ticket)
      log.push(`${ticket} is done: its PR merged`)
      continue
    }
    const question = `Its PR ${t.pr_url} was closed without merging. Reopen it and set the ticket pr_open, or close the ticket in the tracker.`
    await sql(run, db, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(ticket)} and status = 'pr_open'`)
    log.push(`${ticket} needs you: its PR was closed without merging`)
    const stacked = `This ticket is stacked on ${ticket}, whose PR ${t.pr_url} was closed without merging. Unlink it from ${ticket} in the tracker or close it; if it has a PR, retarget or close that, then set the ticket pr_open or send it back to new.`
    const moved = await sql(run, db, `update tickets set status = 'needs_human', restarts = 0, question = ${lit(stacked)} where stacked_on = ${lit(ticket)} and status not in ('done', 'needs_human') returning ticket_id`)
    for (const r of moved) log.push(`${r.ticket_id} needs you: the PR it is stacked on was closed without merging`)
  }
  return { done, log }
}

/** How many unmerged PRs the chain ending at `ticket` holds, counting its own, over `on`: each not-done ticket's stacked_on. */
const height = (on: Map<string, string | null>, ticket: string): number => {
  const below = on.get(ticket)
  return 1 + (below != null && on.has(below) ? height(on, below) : 0)
}

const stackedOn = async (run: Run, db: string) => {
  const rows = await sql(run, db, `select ticket_id, status, pr_url, stacked_on from tickets where status != 'done'`)
  return new Map(rows.map(r => [String(r.ticket_id), r as { status: string; pr_url: string | null; stacked_on: string | null }]))
}

/**
 * With stacking on (`depth` above 1), runs tracker.md's up-to-date command for each pr_open stacked ticket, bottom of
 * its stack first, and sends one whose command fails to needs_human. Resolves what to log.
 */
export const restack = async (run: Run, db: string, tracker: string, depth: number): Promise<string[]> => {
  if (depth === 1) return []
  const cmd = command(tracker, RESTACK)
  const rows = await stackedOn(run, db)
  const on = new Map([...rows].map(([id, r]) => [id, r.stacked_on]))
  const stacked = [...rows].filter(([, r]) => r.status === 'pr_open' && r.stacked_on !== null).sort(([a], [b]) => height(on, a) - height(on, b))
  const log: string[] = []
  for (const [ticket, t] of stacked) {
    const r = await run(['sh', '-c', cmd, 'sh', String(t.pr_url)])
    if (r.exitCode === 0) continue
    const base = rows.get(String(t.stacked_on))?.pr_url ?? t.stacked_on
    const question = `Its PR ${t.pr_url} could not be brought up to date with the PR it is stacked on, ${base}: ${r.stderr.trim()}. Resolve the conflict on its branch, then set the ticket pr_open.`
    await sql(run, db, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(ticket)} and status = 'pr_open'`)
    log.push(`${ticket} needs you: its stacked PR could not be brought up to date`)
  }
  return log
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

/**
 * Pulls the tracker into the pipeline table, following the three commands in tracker.md, in one transaction. With
 * stacking on (`depth` above 1), a ticket whose only unfinished blocker is pr_open is pulled in stacked on it while
 * the stack stays within `depth` and nothing else is stacked on that blocker. Resolves the ids it marked done.
 */
export const sync = async (run: Run, db: string, tracker: string, depth = 1): Promise<string[]> => {
  if (depth > 1 && !/\S/.test(section(tracker, STACK) ?? '')) throw new Error(`tracker.md has no instructions under "## ${STACK}"; run /tracker-setup`)
  const [waiting, done, blockers] = await Promise.all([list(run, tracker, WAITING), list(run, tracker, DONE), list(run, tracker, BLOCKERS)])

  const blocked = new Map<string, Set<string>>()
  for (const b of blockers) {
    const by = id(BLOCKERS, b, 'blocked_by')
    if (![true, false, 0, 1].includes(b.blocker_done as never)) bad(BLOCKERS, b, 'blocker_done')
    if (!b.blocker_done) blocked.set(id(BLOCKERS, b), (blocked.get(id(BLOCKERS, b)) ?? new Set()).add(by))
  }

  const rows = depth > 1 ? await stackedOn(run, db) : new Map()
  const on = new Map([...rows].map(([ticket, r]) => [ticket, r.stacked_on]))
  /** Each blocker with a ticket stacked on it, and that ticket. */
  const above = new Map([...on].filter(([, b]) => b !== null).map(([ticket, b]) => [b, ticket]))
  /** The ticket `ticket` is released stacked on, or undefined when it is held. */
  const base = (ticket: string): string | undefined => {
    const [b, ...more] = blocked.get(ticket) ?? []
    if (b === undefined || more.length > 0) return undefined
    const r = rows.get(b)
    if (r?.status !== 'pr_open' || r.pr_url === null || height(on, b) + 1 > depth || (above.get(b) ?? ticket) !== ticket) return undefined
    above.set(b, ticket)
    return b
  }

  const statements = ['begin;']
  const held: string[] = []
  for (const t of waiting) {
    const ticket = id(WAITING, t)
    if (typeof t.title !== 'string') bad(WAITING, t, 'title')
    if (typeof t.url !== 'string' && t.url !== null) bad(WAITING, t, 'url')
    if (typeof t.body !== 'string' && t.body !== null) bad(WAITING, t, 'body')
    const stack = blocked.has(ticket) ? base(ticket) : null
    if (stack === undefined) {
      held.push(ticket)
      continue
    }
    // stacked_on is recomputed until work starts; a started ticket keeps the one it started on
    statements.push(`insert into tickets (ticket_id, title, url, body, stacked_on) values (${lit(ticket)}, ${lit(t.title as string)}, ${lit(t.url as string | null)}, ${lit(t.body as string | null)}, ${lit(stack)})
      on conflict (ticket_id) do update set title = excluded.title, url = excluded.url, body = excluded.body,
        stacked_on = case when tickets.status in ('new', 'ready') then excluded.stacked_on else tickets.stacked_on end;`)
  }
  // a ticket that became blocked leaves until its blockers are done, unless work on it has started
  for (const ticket of held) statements.push(`delete from tickets where ticket_id = ${lit(ticket)} and status in ('new', 'ready');`)
  const ids = done.map(t => id(DONE, t))
  for (const ticket of ids) statements.push(`update tickets set status = 'done', restarts = 0 where ticket_id = ${lit(ticket)};`, unstack(ticket))
  statements.push('commit;')
  // read before the write: sqlite3 -json prints one array per statement, so a returning inside the transaction would not parse
  const marked = ids.length === 0 ? [] : await sql(run, db, `select ticket_id from tickets where status != 'done' and ticket_id in (${ids.map(lit).join(', ')})`)
  await sql(run, db, statements.join('\n'))
  return marked.map(r => String(r.ticket_id))
}
