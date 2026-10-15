import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentInfo } from 'claude-code'
import { worktreeOf, worktreeRefusal } from '../pipeline-agents/src/guards.ts'

const ROOT = '/home/u/code/app'
const HOME = '/home/u'
const implementer = { id: 'a1', description: 'pipeline T-1', status: 'running', spawnedBy: 'pipeline' } as AgentInfo
const WT = worktreeOf(HOME, ROOT, 'T-1', 'implementer')

const check = (tool: string, input: Record<string, unknown>, agent = implementer) => worktreeRefusal(agent, 'pipeline', ROOT, HOME, tool, input)

test('the worktree is under the home worktree root, named by project, ticket and role', () => {
  // given
  // ... a project root with a trailing slash, a ticket and a role
  // when
  // ... the worktree is named
  const path = worktreeOf(HOME, `${ROOT}/`, 'T-1', 'reviewer-spec')

  // then
  // ... it is <home>/.claude/pipeline-worktrees/<project>/<ticket>-<role>
  assert.equal(path, '/home/u/.claude/pipeline-worktrees/app/T-1-reviewer-spec')
})

test('a ticket id that is not one path segment cannot name a worktree', () => {
  // given
  // ... a ticket id escaping the worktree root
  const ticket = '../../etc'

  // when
  // ... the worktree is named
  const name = () => worktreeOf(HOME, ROOT, ticket, 'implementer')

  // then
  // ... it throws
  assert.throws(name, /cannot name a worktree/)
})

for (const tool of ['Edit', 'Write']) {
  test(`${tool} inside the main checkout is refused, naming the worktree`, () => {
    // given
    // ... an implementer's edit of a file in the main checkout
    const input = { file_path: `${ROOT}/src/a.ts` }

    // when
    // ... the call is checked
    const deny = check(tool, input)

    // then
    // ... it is refused with the worktree to use
    assert.match(String(deny), /main checkout/)
    assert.ok(deny?.includes(WT))
  })
}

test('NotebookEdit inside the main checkout is refused', () => {
  // given
  // ... an implementer's edit of a notebook in the main checkout
  const input = { notebook_path: `${ROOT}/n.ipynb` }

  // when
  // ... the call is checked
  const deny = check('NotebookEdit', input)

  // then
  // ... it is refused
  assert.match(String(deny), /main checkout/)
})

test('an edit inside the agent worktree runs', () => {
  // given
  // ... an implementer's edit of a file in its worktree
  const input = { file_path: `${WT}/src/a.ts` }

  // when
  // ... the call is checked
  const deny = check('Edit', input)

  // then
  // ... it runs
  assert.equal(deny, undefined)
})

test('an edit elsewhere on disk runs', () => {
  // given
  // ... an implementer's write to a temporary file
  const input = { file_path: '/tmp/pr-body.md' }

  // when
  // ... the call is checked
  const deny = check('Write', input)

  // then
  // ... it runs
  assert.equal(deny, undefined)
})

test('an edit of the main checkout through .. and ~ is refused', () => {
  // given
  // ... a path leaving the worktree and a home-relative path, both landing in the main checkout
  const dotted = { file_path: `${WT}/../../../../code/app/src/a.ts` }
  const tilde = { file_path: '~/code/app/./src/a.ts' }

  // when
  // ... both are checked
  const denies = [check('Edit', dotted), check('Edit', tilde)]

  // then
  // ... both are refused
  assert.match(String(denies[0]), /main checkout/)
  assert.match(String(denies[1]), /main checkout/)
})

test('an edit of a path with a variable is refused', () => {
  // given
  // ... a path the guard cannot make absolute
  const input = { file_path: '$WORKTREE/src/a.ts' }

  // when
  // ... the call is checked
  const deny = check('Write', input)

  // then
  // ... it is refused, naming the worktree
  assert.match(String(deny), /cannot be placed/)
  assert.ok(deny?.includes(WT))
})

test('a bare git commit is refused, naming the worktree', () => {
  // given
  // ... an implementer committing from where it stands, the main checkout
  const input = { command: 'git add -A && git commit -m "x"' }

  // when
  // ... the call is checked
  const deny = check('Bash', input)

  // then
  // ... it is refused with the worktree to use
  assert.match(String(deny), /git add in \/home\/u\/code\/app/)
  assert.ok(deny?.includes(WT))
})

test('git -C the worktree and cd the worktree && git run', () => {
  // given
  // ... state-changing git commands placed in the worktree, one from a cd, one from -C, one from a relative -C after cd
  const inputs = [`cd ${WT} && git commit -m "x" && git push -u origin HEAD`, `git -C ${WT} checkout -b feature`, `cd ${WT}; git -C ./sub stash`]

  // when
  // ... each is checked
  const denies = inputs.map(command => check('Bash', { command }))

  // then
  // ... all run
  assert.deepEqual(denies, [undefined, undefined, undefined])
})

test('git -C the main checkout is refused', () => {
  // given
  // ... a reset placed in the main checkout explicitly
  const input = { command: `git -C ${ROOT} reset --hard` }

  // when
  // ... the call is checked
  const deny = check('Bash', input)

  // then
  // ... it is refused
  assert.match(String(deny), /git reset in \/home\/u\/code\/app/)
})

test('read-only git runs from anywhere', () => {
  // given
  // ... read-only git commands from the main checkout, with and without -C, plus a worktree add
  const inputs = ['git status && git log --oneline -3', `git -C ${ROOT} diff main...HEAD | head`, 'git show abc:path', 'git fetch origin x', 'git rev-parse HEAD', `git worktree add ${WT} -b b`, 'git worktree list', `git worktree remove ${WT}`, 'git branch --show-current']

  // when
  // ... each is checked
  const denies = inputs.map(command => check('Bash', { command }))

  // then
  // ... all run
  assert.deepEqual(denies, inputs.map(() => undefined))
})

test('a git command it cannot place is refused', () => {
  // given
  // ... a cd through a variable, then a commit, and a branch delete after a cd to an unknown place
  const inputs = ['cd $WT && git commit -m x', 'cd - && git branch -D old']

  // when
  // ... each is checked
  const denies = inputs.map(command => check('Bash', { command }))

  // then
  // ... both are refused as unplaceable
  assert.match(String(denies[0]), /git commit cannot be placed/)
  assert.match(String(denies[1]), /git branch cannot be placed/)
})

test('a non-git command in the main checkout runs', () => {
  // given
  // ... an implementer running the tests and gh from the main checkout
  const input = { command: 'npm test && gh pr view 1 --json state' }

  // when
  // ... the call is checked
  const deny = check('Bash', input)

  // then
  // ... it runs: shell writes are a known gap
  assert.equal(deny, undefined)
})

test('an agent the pipeline did not spawn is not checked', () => {
  // given
  // ... another plugin's agent, described like a pipeline agent, editing the main checkout
  const other = { ...implementer, spawnedBy: 'other' } as AgentInfo
  const input = { file_path: `${ROOT}/src/a.ts` }

  // when
  // ... the call is checked
  const deny = check('Edit', input, other)

  // then
  // ... it runs
  assert.equal(deny, undefined)
})
