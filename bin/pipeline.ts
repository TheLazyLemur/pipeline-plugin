/**
 * Adds work to the pipeline without an agent, run from the project root as `node <plugin>/bin/pipeline.ts <command>`:
 *   tracker create                      {"title", "body"} JSON on stdin; prints {"id", "url"}
 *   tracker link-blocker <id> <blocker> prints nothing
 *   triage-preview                      {"title", "body"} JSON on stdin; prints triage's verdict as the loop would act on it
 * The two tracker commands run the project mod's `/pipeline-tracker` command in a headless `claude -p` (`tracker` below).
 * Any failure exits 1 with one line on stderr.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { confidenceThreshold } from '../pipeline-agents/src/routing.ts'
import { type Tracker, create, linkBlocker } from '../src/sync.ts'
import { decide, parseVerdict, system, ticketPrompt } from '../src/triage.ts'

const USAGE = 'usage: pipeline.ts tracker create | tracker link-blocker <id> <blocker> | triage-preview'

const file = (name: string) => {
  try {
    return readFileSync(`.claude/pipeline/${name}`, 'utf8')
  } catch {
    throw new Error(`no .claude/pipeline/${name} here; run /tracker-setup`)
  }
}

/** The `{"title", "body"}` draft on stdin. */
const draft = (): { title: string; body: string } => {
  let d: { title?: unknown; body?: unknown } | null = null
  try {
    d = JSON.parse(readFileSync(0, 'utf8'))
  } catch {}
  if (typeof d?.title !== 'string' || d.title.trim() === '' || typeof d.body !== 'string') throw new Error('stdin is not {"title": "<non-empty>", "body": "<markdown>"} JSON')
  return { title: d.title, body: d.body }
}

/** Keeps the session's CLAUDE* vars (CLAUDE_CODE_PLUGIN_DIRS loads plugins) out of `claude -p`, but not the two that pick its login. */
const AUTH = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']
const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') || AUTH.includes(k)))

/** The project mod /tracker-setup writes, loaded by any session started in the project root. */
const MOD = '.claude/skills/pipeline-tracker'

/** One op of the project's tracker tool, outside a session: the mod's `/pipeline-tracker <op> <json args>` answers it with no model turn, printing the result as JSON and exiting 0, or the error and exiting 1. */
const tracker: Tracker = async (op, args = {}) => {
  if (!existsSync(MOD)) throw new Error(`no pipeline tracker mod here (${MOD}); run /tracker-setup`)
  const r = spawnSync('claude', ['-p', '--no-session-persistence', `/pipeline-tracker ${op} ${JSON.stringify(args)}`], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: env(), timeout: 120_000 })
  if (r.error || r.status !== 0) throw new Error(`tracker ${op} failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stdout || r.stderr).trim()}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`tracker ${op} printed ${JSON.stringify(r.stdout.trim().slice(0, 200))}, not JSON`)
  }
}

/** Triages a draft as the loop would triage it as a ticket, with Haiku through `claude -p` since there is no session here. */
const preview = (d: { title: string; body: string }) => {
  const guides = { readiness: file('readiness.md'), rubric: file('rubric.md'), routing: file('routing.md') }
  const min = confidenceThreshold(guides.routing)
  const prompt = ticketPrompt({ ticket_id: 'draft', title: d.title, url: null, body: d.body, answers: null })
  // --safe-mode and no setting sources keep CLAUDE.md, hooks, skills and plugins out; `--tools ""` must not be last, it takes every value after it
  const args = ['-p', '--model', 'haiku', '--effort', 'low', '--system-prompt', system(guides), '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--safe-mode', '--setting-sources', '', prompt]
  const r = spawnSync('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: env(), timeout: 120_000 })
  if (r.error || r.status !== 0) throw new Error(`claude -p failed (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr || r.stdout).trim()}`)
  const v = decide(parseVerdict(r.stdout), min)
  return { status: v.ready ? 'ready' : 'needs_human', ready: v.ready, question: v.question, difficulty: v.difficulty, confidence: v.confidence, model: v.model, reason: v.reason }
}

const main = async ([a, b, ...rest]: string[]): Promise<unknown> => {
  if (a === 'tracker' && b === 'create' && rest.length === 0) return create(tracker, draft())
  if (a === 'tracker' && b === 'link-blocker' && rest.length === 2) return linkBlocker(tracker, rest[0] as string, rest[1] as string)
  if (a === 'triage-preview' && b === undefined) return preview(draft())
  throw new Error(USAGE)
}

main(process.argv.slice(2)).then(
  out => {
    if (out !== undefined) console.log(JSON.stringify(out))
  },
  (e: Error) => {
    console.error(`pipeline ${process.argv.slice(2, 4).join(' ')}: ${e.message.replace(/\s*\n\s*/g, ' ')}`)
    process.exitCode = 1
  },
)
