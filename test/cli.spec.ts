import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { system, ticketPrompt } from '../src/triage.ts'
import { freshProject } from './helpers.ts'

const CLI = join(import.meta.dirname, '../bin/pipeline.ts')
const draft = JSON.stringify({ title: 'Add login', body: 'Google sign-in.\n- a user can sign in with Google' })

/** Runs the CLI in `root` as the TUI does, with `input` on its stdin. */
const cli = (root: string, args: string[], input = '', env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', env })

/** Writes the project mod's folder, as /tracker-setup leaves it; the stub `claude` stands in for what it answers. */
const addMod = (root: string) => mkdirSync(join(root, '.claude/skills/pipeline-tracker'), { recursive: true })

/** Puts a `claude` running `script` on a PATH the CLI is then run with; the rest of the env is only `extra`. */
const stubClaude = (root: string, script: string, extra: Record<string, string> = {}) => {
  const bin = join(root, 'stub-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return { PATH: `${bin}:${process.env.PATH}`, ...extra }
}

test("tracker create runs the mod's /pipeline-tracker command headless from the project root and prints the new ticket as one line", async () => {
  // given
  // ... the mod, a stub claude saving its arguments and cwd and answering a ticket, and a title holding shell text
  const { root } = await freshProject()
  addMod(root)
  const env = stubClaude(root, `printf '%s\\0' "$@" > args\npwd -P > cwd\necho '{"id": "APS-7", "url": "https://t/APS-7"}'`)
  const shelly = { title: 'Quote `$HOME` and "$1"', body: '- [ ] works' }

  // when
  // ... it is created
  const r = cli(root, ['tracker', 'create'], JSON.stringify(shelly), env)

  // then
  // ... claude ran the create op with the draft as JSON, in the project root, and the CLI printed the id and url and nothing else
  assert.deepEqual(readFileSync(join(root, 'args'), 'utf8').split('\0').slice(0, -1), ['-p', '--no-session-persistence', `/pipeline-tracker create ${JSON.stringify(shelly)}`])
  assert.equal(readFileSync(join(root, 'cwd'), 'utf8'), `${realpathSync(root)}\n`)
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '{"id":"APS-7","url":"https://t/APS-7"}\n', ''])
})

test('tracker create fails when the op returns an id that is not one path segment', async () => {
  // given
  // ... the mod, a stub claude printing out.txt, and results with a reference, `..`, an empty id, a number and no JSON
  const { root } = await freshProject()
  addMod(root)
  const env = stubClaude(root, `cat "${root}/out.txt"`)
  const printed = ['{"id": "owner/repo#7", "url": null}', '{"id": "..", "url": null}', '{"id": "", "url": null}', '{"id": 7, "url": null}', 'created #7']

  // when
  // ... a draft is created against each
  const results = printed.map(out => {
    writeFileSync(join(root, 'out.txt'), out)
    return cli(root, ['tracker', 'create'], draft, env)
  })

  // then
  // ... each exits 1 with nothing on stdout and one line on stderr naming the op
  assert.deepEqual(results.map(r => [r.status, r.stdout]), printed.map(() => [1, '']))
  for (const r of results) assert.match(r.stderr, /^pipeline tracker create: tracker create (returned [^\n]*, not \{"id": "<one path segment>"|printed "created #7", not JSON)[^\n]*\n$/)
})

test('tracker create fails with the error the /pipeline-tracker command answered', async () => {
  // given
  // ... the mod, and a stub claude answering the op's error and exiting 1, as the command does when the op fails
  const { root } = await freshProject()
  addMod(root)
  const env = stubClaude(root, `echo 'jira: auth expired'\nexit 1`)

  // when
  // ... a draft is created
  const r = cli(root, ['tracker', 'create'], draft, env)

  // then
  // ... it exits 1 with the error on one line
  assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', 'pipeline tracker create: tracker create failed (exit 1): jira: auth expired\n'])
})

test('without the tracker mod, tracker create says to run /tracker-setup and runs no claude', async () => {
  // given
  // ... a project with no mod, and a stub claude that records being run
  const { root } = await freshProject()
  const env = stubClaude(root, `touch "${root}/ran"`)

  // when
  // ... a draft is created
  const r = cli(root, ['tracker', 'create'], draft, env)

  // then
  // ... it exits 1 naming the fix, and claude never ran
  assert.deepEqual([r.status, r.stderr], [1, 'pipeline tracker create: no pipeline tracker mod here (.claude/skills/pipeline-tracker); run /tracker-setup\n'])
  assert.equal(existsSync(join(root, 'ran')), false)
})

test('tracker link-blocker runs the link_blocker op with the ticket and its blocker and prints nothing', async () => {
  // given
  // ... the mod, and a stub claude saving its arguments and answering ok
  const { root } = await freshProject()
  addMod(root)
  const env = stubClaude(root, `printf '%s\\0' "$@" > args\necho '"ok"'`)

  // when
  // ... APS-7 is linked as blocked by APS-3
  const r = cli(root, ['tracker', 'link-blocker', 'APS-7', 'APS-3'], '', env)

  // then
  // ... claude ran the op with both ids and the CLI printed nothing
  assert.deepEqual(readFileSync(join(root, 'args'), 'utf8').split('\0').slice(0, -1), ['-p', '--no-session-persistence', '/pipeline-tracker link_blocker {"id":"APS-7","blocked_by":"APS-3"}'])
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
