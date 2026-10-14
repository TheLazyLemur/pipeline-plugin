import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProcessRunResult } from 'claude-code'
import { DB, type Run, SCHEMA, sql } from '../src/store.ts'
import { BLOCKERS, DONE, MARK_DONE, MERGED, WAITING } from '../src/sync.ts'

/** `$.process.run` over child_process. */
export const run: Run = async (argv, init) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(argv[0], argv.slice(1), { cwd: init?.cwd })
    return { exitCode: 0, stdout, stderr } as ProcessRunResult
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string }
    return { exitCode: err.code, stdout: err.stdout, stderr: err.stderr } as ProcessRunResult
  }
}

/** A fresh database with the schema applied. */
export const freshDb = async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'pipeline-')), 'pipeline.db')
  await sql(run, db, SCHEMA)
  return db
}

/** A project set up as /tracker-setup leaves it, with the schema applied; `run` already has it as cwd, `root` is its path. */
export const freshProject = async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-project-'))
  mkdirSync(join(root, '.claude/pipeline'), { recursive: true })
  for (const name of ['readiness', 'rubric', 'routing']) writeFileSync(join(root, `.claude/pipeline/${name}.md`), `# ${name}\n`)
  // a tracker with nothing in it: each sync command prints no rows and no PR has merged
  const empty = [WAITING, DONE, BLOCKERS, MARK_DONE].map(h => `## ${h}\n\`\`\`sh\ntrue\n\`\`\`\n`).join('')
  writeFileSync(join(root, '.claude/pipeline/tracker.md'), `# tracker\n${empty}## ${MERGED}\n\`\`\`sh\necho '{"merged": false}'\n\`\`\`\n`)
  const inRoot: Run = (argv, init) => run(argv, { cwd: root, ...init })
  await sql(inRoot, DB, SCHEMA)
  return { run: inRoot, db: DB, root }
}
