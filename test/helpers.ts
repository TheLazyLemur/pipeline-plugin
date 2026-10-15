import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProcessRunResult } from 'claude-code'
import { DB, type Run, SCHEMA, sql } from '../pipeline-agents/src/store.ts'
import type { Tracker } from '../src/sync.ts'

/** `$.process.run` over child_process. */
export const run: Run = async ([cmd, ...args], init) => {
  assert(cmd, 'run needs a command')
  const ended = (exitCode: number, stdout: string, stderr: string): ProcessRunResult =>
    ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  try {
    const { stdout, stderr } = await promisify(execFile)(cmd, args, { cwd: init?.cwd })
    return ended(0, stdout, stderr)
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string }
    return ended(err.code, err.stdout, err.stderr)
  }
}

/** A fresh database with the schema applied. */
export const freshDb = async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'pipeline-')), 'pipeline.db')
  await sql(run, db, SCHEMA)
  return db
}

/** A tracker tool over `ops`, each op answering from its arguments; an op not given rejects, as the mod's unknown op does. */
export const fakeTracker = (ops: Record<string, (args: Record<string, unknown>) => unknown>): Tracker => async (op, args = {}) => {
  const answer = ops[op]
  if (answer === undefined) throw new Error(`no op ${op}`)
  return answer(args)
}

/** A tracker with nothing in it: no ticket waiting, done or blocked, and no PR merged. */
export const emptyTracker = () => fakeTracker({ waiting: () => [], done: () => [], blockers: () => [], pr_merged: () => ({ merged: false }), mark_done: () => 'ok' })

/** A project set up as /tracker-setup leaves it (its tracker tool is the Deps' own), with the schema applied; `run` already has it as cwd, `root` is its path. */
export const freshProject = async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-project-'))
  mkdirSync(join(root, '.claude/pipeline'), { recursive: true })
  for (const name of ['readiness', 'rubric', 'routing']) writeFileSync(join(root, `.claude/pipeline/${name}.md`), `# ${name}\n`)
  const inRoot: Run = (argv, init) => run(argv, { cwd: root, ...init })
  await sql(inRoot, DB, SCHEMA)
  return { run: inRoot, db: DB, root }
}
