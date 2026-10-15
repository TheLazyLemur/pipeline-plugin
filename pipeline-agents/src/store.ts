import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

/** The shape of `$.process.run`; the mod passes `(argv, init) => $.process.run(argv, init)`, tests a child_process shim. */
export type Run = (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>

export type Status = 'new' | 'needs_human' | 'ready' | 'in_progress' | 'pr_open' | 'done'

/** Where an `in_progress` ticket stands; null (a row from before stages) reads as `implement`. */
export type Stage = 'implement' | 'review' | 'verify' | 'fix'

export type Ticket = {
  ticket_id: string
  title: string
  url: string | null
  /** The ticket's description plus acceptance criteria, filled by sync. */
  body: string | null
  status: Status
  stage: Stage | null
  /** 0 while the agents of `stage` are still to be started by the loop's pass; 1 once started. */
  started: 0 | 1
  /** The `$.session.id()` of the session whose loop claimed the ticket; it alone moves the ticket's stages on. */
  owner: string | null
  /** When the owner's pass last ran, as SQLite `datetime('now')`; stale for 15 minutes, the owner is taken as stopped. */
  owner_seen: string | null
  /** 1 once the loop restarted this ticket's vanished verifier or fixer; a second vanishing goes to needs_human. Back to 0 when the ticket leaves in_progress. */
  restarts: 0 | 1
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
  stage text check (stage in ('implement', 'review', 'verify', 'fix')),
  started integer not null default 1 check (started in (0, 1)),
  owner text,
  owner_seen text,
  restarts integer not null default 0 check (restarts in (0, 1)),
  question text,
  difficulty integer check (difficulty between 1 and 5),
  confidence real check (confidence between 0 and 1),
  model text check (model in ('haiku', 'sonnet', 'opus', 'fable')),
  reason text,
  pr_url text,
  learned integer not null default 0 check (learned in (0, 1))
);
create table if not exists turns (
  ticket_id text not null,
  role text not null check (role in ('implementer', 'reviewer-spec', 'reviewer-quality', 'verifier', 'fixer')),
  model text,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_tokens integer not null,
  cache_write_tokens integer not null,
  duration_ms integer not null
);
create table if not exists agent_runs (
  agent_id text primary key,
  ticket_id text not null,
  role text not null check (role in ('implementer', 'reviewer-spec', 'reviewer-quality', 'verifier', 'fixer')),
  started_at integer not null,
  requests integer not null default 0,
  context_tokens integer not null default 0,
  nudged_token integer not null default 0 check (nudged_token in (0, 1)),
  nudged_time integer not null default 0 check (nudged_time in (0, 1)),
  soft_stop_at integer,
  soft_limit text check (soft_limit in ('token', 'time'))
);
drop view if exists role_usage;
create view role_usage as
  select ticket_id, role, group_concat(distinct model) as model, count(*) as turns,
    sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as tokens,
    sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
    sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
    round(sum(duration_ms) / 60000.0, 1) as minutes
  from turns group by ticket_id, role;
drop view if exists ticket_usage;
create view ticket_usage as
  select ticket_id, sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as tokens,
    round(sum(duration_ms) / 60000.0, 1) as minutes
  from turns group by ticket_id;`

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
  // .timeout: the loop and the hooks write the same file from overlapping calls
  const r = await run(['sqlite3', '-bail', '-json', '-cmd', '.timeout 5000', db, statement])
  if (r.exitCode !== 0) throw new Error(`sqlite3 exited ${r.exitCode}: ${r.stderr.trim()}`)
  return r.stdout.trim() === '' ? [] : JSON.parse(r.stdout)
}

/** Columns added after the first schema, with their definitions as in SCHEMA. */
const ADDED: Record<string, string> = {
  body: 'text',
  stage: `text check (stage in ('implement', 'review', 'verify', 'fix'))`,
  started: 'integer not null default 1 check (started in (0, 1))',
  owner: 'text',
  owner_seen: 'text',
  restarts: 'integer not null default 0 check (restarts in (0, 1))',
}

/** Applies SCHEMA, and adds the columns a database made before them is missing. */
export const migrate = async (run: Run, db: string) => {
  await sql(run, db, SCHEMA)
  const have = (await sql(run, db, `select name from pragma_table_info('tickets')`)).map(c => c.name)
  for (const [name, def] of Object.entries(ADDED)) if (!have.includes(name)) await sql(run, db, `alter table tickets add column ${name} ${def}`)
}
