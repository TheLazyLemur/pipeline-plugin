import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

/** The shape of `$.process.run`; the mod passes `(argv, init) => $.process.run(argv, init)`, tests a child_process shim. */
export type Run = (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>

export type Status = 'new' | 'needs_human' | 'ready' | 'in_progress' | 'pr_open' | 'done'

export type Ticket = {
  ticket_id: string
  title: string
  url: string | null
  /** The ticket's description plus acceptance criteria, filled by sync. */
  body: string | null
  status: Status
  question: string | null
  difficulty: number | null
  confidence: number | null
  model: string | null
  reason: string | null
  pr_url: string | null
  learned: 0 | 1
}

export const DB = '.claude/pipeline/pipeline.db'

export const SCHEMA = `create table if not exists tickets (
  ticket_id text primary key,
  title text not null,
  url text,
  body text,
  status text not null default 'new'
    check (status in ('new', 'needs_human', 'ready', 'in_progress', 'pr_open', 'done')),
  question text,
  difficulty integer check (difficulty between 1 and 5),
  confidence real check (confidence between 0 and 1),
  model text check (model in ('haiku', 'sonnet', 'opus', 'fable')),
  reason text,
  pr_url text,
  learned integer not null default 0 check (learned in (0, 1))
);`

/** A SQL literal: strings quoted with `'` doubled, so ticket text cannot break out of the statement. */
export const lit = (v: string | number | null): string => {
  if (v === null) return 'null'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`)
    return String(v)
  }
  return `'${v.replaceAll("'", "''")}'`
}

/** Runs one or more statements against `db`; resolves the rows of the last select, empty for writes. */
export const sql = async (run: Run, db: string, statement: string): Promise<Record<string, unknown>[]> => {
  // .timeout: the implementer agent writes the same file through its own sqlite3
  const r = await run(['sqlite3', '-bail', '-json', '-cmd', '.timeout 5000', db, statement])
  if (r.exitCode !== 0) throw new Error(`sqlite3 exited ${r.exitCode}: ${r.stderr.trim()}`)
  return r.stdout.trim() === '' ? [] : JSON.parse(r.stdout)
}

/** Applies SCHEMA, and adds the columns a database made before them is missing. */
export const migrate = async (run: Run, db: string) => {
  await sql(run, db, SCHEMA)
  const body = await sql(run, db, `select name from pragma_table_info('tickets') where name = 'body'`)
  if (body.length === 0) await sql(run, db, `alter table tickets add column body text`)
}
