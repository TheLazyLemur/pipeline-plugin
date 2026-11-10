import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { CREATE, LINK_BLOCKER } from '../src/sync.ts'
import { system, ticketPrompt } from '../src/triage.ts'
import { freshProject } from './helpers.ts'

const CLI = join(import.meta.dirname, '../bin/pipeline.ts')
const draft = JSON.stringify({ title: 'Add login', body: 'Google sign-in.\n- a user can sign in with Google' })

/** Runs the CLI in `root` as the TUI does, with `input` on its stdin. */
const cli = (root: string, args: string[], input = '', env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', env })

/** Adds a section with `cmd` as its command to the project's tracker.md. */
const addSection = (root: string, heading: string, cmd: string) =>
  appendFileSync(join(root, '.claude/pipeline/tracker.md'), `## ${heading}\n\`\`\`sh\n${cmd}\n\`\`\`\n`)

/** Puts a `claude` running `script` on a PATH the CLI is then run with; the rest of the env is only `extra`. */
const stubClaude = (root: string, script: string, extra: Record<string, string> = {}) => {
  const bin = join(root, 'stub-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return { PATH: `${bin}:${process.env.PATH}`, ...extra }
}

test('tracker create hands the draft to tracker.md as JSON on stdin and prints the new ticket as one line', async () => {
  // given
  // ... a create command that saves its stdin and prints a ticket, and a title holding shell text
  const { root } = await freshProject()
  addSection(root, CREATE, `cat > got.json\necho '{"id": "APS-7", "url": "https://t/APS-7"}'`)
  const shelly = { title: 'Quote `$HOME` and "$1"', body: '- [ ] works' }

  // when
  // ... it is created
  const r = cli(root, ['tracker', 'create'], JSON.stringify(shelly))

  // then
  // ... the command got the draft as data, and the CLI printed the id and url and nothing else
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'got.json'), 'utf8')), shelly)
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '{"id":"APS-7","url":"https://t/APS-7"}\n', ''])
})

test('tracker create fails when the command prints an id that is not one path segment', async () => {
  // given
  // ... a create command printing out.txt, and outputs with a reference, `..`, an empty id, a number and no JSON
  const { root } = await freshProject()
  addSection(root, CREATE, 'cat out.txt')
  const printed = ['{"id": "owner/repo#7", "url": null}', '{"id": "..", "url": null}', '{"id": "", "url": null}', '{"id": 7, "url": null}', 'created #7']

  // when
  // ... a draft is created against each
  const results = printed.map(out => {
    writeFileSync(join(root, 'out.txt'), out)
    return cli(root, ['tracker', 'create'], draft)
  })

  // then
  // ... each exits 1 with nothing on stdout and one line on stderr naming the command
  assert.deepEqual(results.map(r => [r.status, r.stdout]), printed.map(() => [1, '']))
  for (const r of results) assert.match(r.stderr, /^pipeline tracker create: "Create a ticket" printed [^\n]*, not \{"id": "<one path segment>"[^\n]*\n$/)
})

test('a tracker.md without the create command says to run /tracker-setup', async () => {
  // given
  // ... a tracker.md written before the create command existed
  const { root } = await freshProject()

  // when
  // ... a draft is created
  const r = cli(root, ['tracker', 'create'], draft)

  // then
  // ... it exits 1 naming the missing section
  assert.deepEqual([r.status, r.stderr], [1, 'pipeline tracker create: tracker.md has no command under "## Create a ticket"; run /tracker-setup\n'])
})

test('tracker link-blocker passes the ticket and its blocker as $1 and $2 and prints nothing', async () => {
  // given
  // ... a link command that saves its arguments
  const { root } = await freshProject()
  addSection(root, LINK_BLOCKER, `printf '%s blocked by %s' "$1" "$2" > linked.txt`)

  // when
  // ... APS-7 is linked as blocked by APS-3
  const r = cli(root, ['tracker', 'link-blocker', 'APS-7', 'APS-3'])

  // then
  // ... the command got both ids and the CLI printed nothing
  assert.equal(readFileSync(join(root, 'linked.txt'), 'utf8'), 'APS-7 blocked by APS-3')
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''])
})

test('triage-preview runs claude -p with the prompts triage uses, and without the session CLAUDE vars that load plugins', async () => {
  // given
  // ... a stub claude saving its arguments and CLAUDE vars, run from a session with plugin dirs and its own config dir
  const { root } = await freshProject()
  const verdict = '{"ready": true, "question": null, "difficulty": 2, "confidence": 0.9, "model": "sonnet", "reason": "clear"}'
  const env = stubClaude(root, `printf '%s\\0' "$@" > args\nenv | grep '^CLAUDE' > claude-env\necho '${verdict}'`, {
    CLAUDECODE: '1',
    CLAUDE_CODE_PLUGIN_DIRS: '/plugins',
    CLAUDE_CONFIG_DIR: '/config',
  })

  // when
  // ... a draft is previewed
  const r = cli(root, ['triage-preview'], draft, env)

  // then
  // ... claude got triage's system prompt from the project's guides and its ticket prompt, and only the login var
  const guides = { readiness: '# readiness\n', rubric: '# rubric\n', routing: '# routing\n' }
  const prompt = ticketPrompt({ ticket_id: 'draft', title: 'Add login', url: null, body: 'Google sign-in.\n- a user can sign in with Google', answers: null })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readFileSync(join(root, 'args'), 'utf8').split('\0').slice(0, -1), [
    '-p', '--model', 'haiku', '--effort', 'low', '--system-prompt', system(guides), '--tools', '', '--no-session-persistence',
    '--strict-mcp-config', '--safe-mode', '--setting-sources', '', prompt,
  ])
  assert.equal(readFileSync(join(root, 'claude-env'), 'utf8'), 'CLAUDE_CONFIG_DIR=/config\n')
})

test("triage-preview sends a ready draft below routing.md's confidence threshold to needs_human, as the loop does", async () => {
  // given
  // ... routing.md raising the threshold to 0.9, and Haiku judging the draft ready at 0.8, its JSON wrapped in prose
  const { root } = await freshProject()
  writeFileSync(join(root, '.claude/pipeline/routing.md'), '# routing\nConfidence threshold: 0.9\n')
  const env = stubClaude(root, `echo 'Here: {"ready": true, "question": null, "difficulty": 2, "confidence": 0.8, "model": "sonnet", "reason": "clear"} Done.'`)

  // when
  // ... a draft is previewed
  const r = cli(root, ['triage-preview'], draft, env)

  // then
  // ... one line of JSON says needs_human, with the question the loop would ask
  assert.equal(r.stdout, `${JSON.stringify({
    status: 'needs_human',
    ready: false,
    question: 'Triage judged this ready but was unsure (confidence 0.8, below 0.9). Its reason: "clear" Confirm it is ready, or say what is missing.',
    difficulty: 2,
    confidence: 0.8,
    model: 'sonnet',
    reason: 'clear',
  })}\n`)
})
