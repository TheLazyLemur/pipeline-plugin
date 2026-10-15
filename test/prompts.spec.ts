import assert from 'node:assert/strict'
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
