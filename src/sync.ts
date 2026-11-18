import { namesWorktree } from '../pipeline-agents/src/guards.ts'
import { type Run, lit, sql } from '../pipeline-agents/src/store.ts'

/** One call of the project's tracker tool (`TRACKER_TOOL`): `op` and its arguments in, the op's result out; rejects with the reason the op failed. */
export type Tracker = (op: string, args?: Record<string, unknown>) => Promise<unknown>

type Row = Record<string, unknown>

/** Calls one op that returns a list of rows. */
const list = async (tracker: Tracker, op: string): Promise<Row[]> => {
  const rows = await tracker(op)
  if (!Array.isArray(rows) || !rows.every(row => typeof row === 'object' && row !== null)) throw new Error(`tracker ${op} did not return an array of objects: ${String(JSON.stringify(rows)).slice(0, 200)}`)
  return rows
}

/** Creates a ticket in the tracker's waiting status; resolves its id and url. */
export const create = async (tracker: Tracker, draft: { title: string; body: string }): Promise<{ id: string; url: string | null }> => {
  const t = (await tracker('create', draft)) as { id?: unknown; url?: unknown } | null
  if (typeof t?.id !== 'string' || !namesWorktree(t.id) || (typeof t.url !== 'string' && t.url !== null)) {
    throw new Error(`tracker create returned ${String(JSON.stringify(t)).slice(0, 200)}, not {"id": "<one path segment>", "url": "<url>"|null}`)
  }
  return { id: t.id, url: t.url }
}

/** Records in the tracker that `ticket` is blocked by `blocker`. */
export const linkBlocker = async (tracker: Tracker, ticket: string, blocker: string) => {
  for (const v of [ticket, blocker]) if (!namesWorktree(v)) throw new Error(`${JSON.stringify(v)} is not a ticket id`)
  await tracker('link_blocker', { id: ticket, blocked_by: blocker })
}

/** Frees the tickets stacked on `ticket`, which is done: the host retargets their PRs, so each is an ordinary PR. */
const unstack = (ticket: string) => `update tickets set stacked_on = null where stacked_on = ${lit(ticket)};`

const ANSWERS = ['{"merged":true}', '{"merged":false}', '{"merged":false,"closed":true}']

/**
 * Marks done, in the tracker and the table, every pr_open ticket whose PR has merged, so sync can release its
 * dependents; sends one whose PR was closed unmerged to needs_human, with every ticket stacked on it. Resolves the
 * ids marked done and what to log.
 */
export const closeMerged = async (tracker: Tracker, run: Run, db: string): Promise<{ done: string[]; log: string[] }> => {
  const open = await sql(run, db, `select ticket_id, pr_url from tickets where status = 'pr_open' order by rowid`)
  const done: string[] = []
  const log: string[] = []
  for (const t of open) {
    const ticket = String(t.ticket_id)
    if (typeof t.pr_url !== 'string') throw new Error(`${ticket} is pr_open with no pr_url`)
    const answer = String(JSON.stringify(await tracker('pr_merged', { url: t.pr_url })))
    if (!ANSWERS.includes(answer)) throw new Error(`tracker pr_merged returned ${answer.slice(0, 200)} for ${t.pr_url}, not {"merged": true|false} or {"merged": false, "closed": true}`)
    if (answer === '{"merged":false}') continue
    if (answer === '{"merged":true}') {
      await tracker('mark_done', { id: ticket })
      await sql(run, db, `update tickets set status = 'done' where ticket_id = ${lit(ticket)} and status = 'pr_open'; ${unstack(ticket)}`)
      done.push(ticket)
      log.push(`${ticket} is done: its PR merged`)
      continue
    }
    const question = `Its PR ${t.pr_url} was closed without merging. Reopen it and set the ticket pr_open, or close the ticket in the tracker.`
    await sql(run, db, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(ticket)} and status = 'pr_open'`)
    log.push(`${ticket} needs you: its PR was closed without merging`)
    const stacked = `This ticket is stacked on ${ticket}, whose PR ${t.pr_url} was closed without merging. Unlink it from ${ticket} in the tracker or close it; if it has a PR, retarget or close that, then set the ticket pr_open or send it back to new.`
    const moved = await sql(
      run,
      db,
      `with recursive above(ticket_id) as (select ticket_id from tickets where stacked_on = ${lit(ticket)} union select t.ticket_id from tickets t join above a on t.stacked_on = a.ticket_id)
       update tickets set status = 'needs_human', restarts = 0, question = ${lit(stacked)} where ticket_id in (select ticket_id from above) and status not in ('done', 'needs_human') returning ticket_id`,
    )
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
 * With stacking on (`depth` above 1), calls the tracker's `pr_restack` for each pr_open stacked ticket, bottom of its
 * stack first, and sends one whose call fails to needs_human. Resolves what to log.
 */
export const restack = async (tracker: Tracker, run: Run, db: string, depth: number): Promise<string[]> => {
  if (depth === 1) return []
  const rows = await stackedOn(run, db)
  const on = new Map([...rows].map(([id, r]) => [id, r.stacked_on]))
  const stacked = [...rows].filter(([, r]) => r.status === 'pr_open' && r.stacked_on !== null).sort(([a], [b]) => height(on, a) - height(on, b))
  const log: string[] = []
  for (const [ticket, t] of stacked) {
    let failed: string
    try {
      await tracker('pr_restack', { url: t.pr_url })
      continue
    } catch (err) {
      failed = (err as Error).message
    }
    const base = rows.get(String(t.stacked_on))?.pr_url ?? t.stacked_on
    const question = `Its PR ${t.pr_url} could not be brought up to date with the PR it is stacked on, ${base}: ${failed}. Resolve the conflict on its branch, then set the ticket pr_open.`
    await sql(run, db, `update tickets set status = 'needs_human', question = ${lit(question)} where ticket_id = ${lit(ticket)} and status = 'pr_open'`)
    log.push(`${ticket} needs you: its stacked PR could not be brought up to date`)
  }
  return log
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

/**
 * Pulls the tracker into the pipeline table, from its `waiting`, `done` and `blockers` ops, in one transaction. With
 * stacking on (`depth` above 1), a ticket whose only unfinished blocker is pr_open is pulled in stacked on it while
 * the stack stays within `depth` and nothing else is stacked on that blocker. Resolves the ids it marked done.
 */
export const sync = async (tracker: Tracker, run: Run, db: string, depth = 1): Promise<string[]> => {
  const [waiting, done, blockers] = await Promise.all([list(tracker, 'waiting'), list(tracker, 'done'), list(tracker, 'blockers')])

  const blocked = new Map<string, Set<string>>()
  for (const b of blockers) {
    const by = id('blockers', b, 'blocked_by')
    if (![true, false, 0, 1].includes(b.blocker_done as never)) bad('blockers', b, 'blocker_done')
    if (!b.blocker_done) blocked.set(id('blockers', b), (blocked.get(id('blockers', b)) ?? new Set()).add(by))
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
    const ticket = id('waiting', t)
    if (typeof t.title !== 'string') bad('waiting', t, 'title')
    if (typeof t.url !== 'string' && t.url !== null) bad('waiting', t, 'url')
    if (typeof t.body !== 'string' && t.body !== null) bad('waiting', t, 'body')
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
  const ids = done.map(t => id('done', t))
  for (const ticket of ids) statements.push(`update tickets set status = 'done', restarts = 0 where ticket_id = ${lit(ticket)};`, unstack(ticket))
  statements.push('commit;')
  // read before the write: sqlite3 -json prints one array per statement, so a returning inside the transaction would not parse
  const marked = ids.length === 0 ? [] : await sql(run, db, `select ticket_id from tickets where status != 'done' and ticket_id in (${ids.map(lit).join(', ')})`)
  await sql(run, db, statements.join('\n'))
  return marked.map(r => String(r.ticket_id))
}
