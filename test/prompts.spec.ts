import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { promptsChanged } from '../src/prompts.ts'

test('a reload after agent prompts changed names every changed, added or removed file and asks for a restart', () => {
  // given
  // ... the prompts at session start, and now one edited, one added and one removed
  const atStart = { 'fixer.md': 1, 'verifier.md': 2, 'reviewer-spec.md': 3 }
  const now = { 'fixer.md': 5, 'verifier.md': 2, 'implementer-opus.md': 4 }

  // when
  // ... the two are compared
  const line = promptsChanged(atStart, now)

  // then
  // ... one line names the three files and asks for a restart
  assert.equal(line, 'agent prompts changed (agents/fixer.md, agents/implementer-opus.md, agents/reviewer-spec.md); restart the session to apply them')
})

test('a reload with no agent prompt changed logs nothing', () => {
  // given
  // ... the same prompts at session start and now
  const atStart = { 'fixer.md': 1, 'verifier.md': 2 }

  // when
  // ... the two are compared
  const line = promptsChanged(atStart, { ...atStart })

  // then
  // ... there is no line to log
  assert.equal(line, null)
})

const read = (path: string) => readFileSync(join(import.meta.dirname, '..', path), 'utf8')

/** Every agent prompt, with the tracker ops it uses; the agents reach the tracker and PR host through the tool alone. */
const AGENTS: Record<string, readonly string[]> = {
  'agents/implementer-sonnet.md': ['read', 'move', 'pr_create', 'link_pr'],
  'agents/implementer-opus.md': ['read', 'move', 'pr_create', 'link_pr'],
  'agents/implementer-fable.md': ['read', 'move', 'pr_create', 'link_pr'],
  'agents/reviewer-spec.md': ['read', 'pr_diff', 'pr_view', 'comment'],
  'agents/reviewer-quality.md': ['read', 'pr_diff', 'pr_view', 'comment'],
  'agents/verifier.md': ['read', 'pr_diff', 'pr_view', 'comment', 'pr_comment', 'pr_ready'],
  'agents/fixer.md': ['read', 'pr_view', 'pr_edit', 'pr_comment', 'pr_ready'],
}

test('every agent prompt is listed with the tracker ops it uses', () => {
  // given
  // ... the agent prompt files on disk
  const files = readdirSync(join(import.meta.dirname, '../agents')).map(name => `agents/${name}`)

  // when
  // ... they are compared with the listed prompts
  const listed = Object.keys(AGENTS)

  // then
  // ... none is missing from the list
  assert.deepEqual(files.sort(), listed.sort())
})

for (const path of [...Object.keys(AGENTS), 'skills/learn/SKILL.md', 'skills/pipeline-status/SKILL.md']) {
  test(`${path} runs no gh pr command and names no tracker.md`, () => {
    // given
    // ... the prompt as the agent or skill reads it
    const text = read(path)

    // when
    // ... it is searched for the host's CLI and the old tracker file
    const found = text.match(/gh pr|gh api|tracker\.md|tracker\.sh/g)

    // then
    // ... neither is there, and it names the tracker tool
    assert.equal(found, null)
    assert.match(text, /mcp__pipeline-tracker__tracker/)
  })
}

for (const [path, ops] of Object.entries(AGENTS)) {
  test(`${path} names the tracker ops it uses`, () => {
    // given
    // ... the agent prompt
    const text = read(path)

    // when
    // ... each op it uses is looked for as code
    const missing = ops.filter(op => !text.includes(`\`${op}\``))

    // then
    // ... every one is named
    assert.deepEqual(missing, [])
  })
}
