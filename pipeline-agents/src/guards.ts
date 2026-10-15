import type { AgentInfo } from 'claude-code'
import { type Role, agentOf } from './agents.ts'

/** Where every pipeline agent's worktree lives, under the user's home: `<home>/.claude/pipeline-worktrees/<project>/<ticket>-<role>`. */
export const WORKTREES = '.claude/pipeline-worktrees'

/** The tools the worktree guard checks. */
export const GUARDED = ['Edit', 'Write', 'NotebookEdit', 'Bash'] as const

/** One path segment a worktree name may be built from: a ticket id or a project folder name. */
const SEGMENT = /^[\w.@+-]+$/

/** The worktree of `role` for `ticket` of the project at `root`; throws on a ticket id or project name that is not one path segment. */
export const worktreeOf = (home: string, root: string, ticket: string, role: Role): string => {
  const project = root.replace(/\/+$/, '').split('/').pop() ?? ''
  for (const part of [project, ticket]) if (!SEGMENT.test(part) || part === '.' || part === '..') throw new Error(`cannot name a worktree from ${JSON.stringify(part)}`)
  return `${home}/${WORKTREES}/${project}/${ticket}-${role}`
}

/**
 * `path` made absolute against `cwd` with `.`, `..` and `~` resolved as text, or null when it cannot be placed:
 * empty, `-`, a shell expansion (`$VAR`, a glob) or an unknown cwd. Symlinks are not resolved.
 */
export const resolve = (path: string, cwd: string | null, home: string): string | null => {
  const p = path.replace(/^(["'])(.*)\1$/, '$2')
  if (p === '' || p === '-' || /[$`*?]/.test(p)) return null
  const abs = p === '~' || p.startsWith('~/') ? home + p.slice(1) : p.startsWith('/') ? p : cwd === null ? null : `${cwd}/${p}`
  if (abs === null) return null
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '' && part !== '.') out.push(part)
  }
  return `/${out.join('/')}`
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** Git subcommands that change nothing, allowed from anywhere; `branch` is one when it only lists. */
const READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'fetch', 'rev-parse', 'worktree', 'ls-files', 'ls-tree', 'ls-remote', 'blame', 'grep', 'describe', 'cat-file', 'rev-list'])
const listsBranches = (args: string[]) => args.every(a => a.startsWith('-')) && !args.some(a => /^-[dDmMcCu]|^--(delete|move|copy|set-upstream-to|unset-upstream)/.test(a))

/** Words a command may start with before the command itself. */
const WRAPPERS = new Set(['rtk', 'command', 'exec', 'env', 'time'])

/** Each simple command of a shell command line, roughly: split on the shell's separators, subshells and substitutions. */
const commands = (command: string) =>
  command
    .split(/\|\||&&|[;|&()\n`]/)
    .map(s => s.trim().split(/\s+/).filter(w => !/^\w+=/.test(w) && !WRAPPERS.has(w)))
    .filter(w => w.length > 0)

/**
 * The state-changing git command of `command` that is not placed in `worktree`, as `[subcommand, where]` (`where`
 * null when it cannot be placed), or undefined when every git command is read-only or targets the worktree. The
 * command starts in `root`; `cd` moves it, `git -C` places one command.
 */
const misplacedGit = (command: string, root: string, home: string, worktree: string): [string, string | null] | undefined => {
  let cwd: string | null = root
  for (const words of commands(command)) {
    if (words[0] === 'cd') {
      cwd = words[1] === undefined ? home : resolve(words[1], cwd, home)
      continue
    }
    if (words[0] !== 'git') continue
    let where = cwd
    let i = 1
    for (; i < words.length && words[i]!.startsWith('-'); i++) {
      if (words[i] === '-C') where = resolve(words[++i] ?? '', where, home)
      else if (words[i] === '-c') i++
    }
    const sub = words[i]
    const args = words.slice(i + 1)
    if (sub === undefined || READ_ONLY.has(sub) || (sub === 'branch' && listsBranches(args))) continue
    if (where === null || !within(where, worktree)) return [sub, where]
  }
  return undefined
}

const target = (input: Record<string, unknown>) => {
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' ? p : ''
}

const how = (worktree: string) => `Work in your worktree, ${worktree} (git worktree add ${worktree} …), and target it in git commands with cd ${worktree} && … or git -C ${worktree} ….`

/**
 * The refusal for a pipeline agent's edit inside the main checkout at `root`, or its state-changing git command
 * not explicitly placed in its own worktree, or undefined to let the call run. Fails closed: a path or a command it
 * cannot place is refused. Any other agent is not checked.
 */
export const worktreeRefusal = (agent: AgentInfo | undefined, plugin: string, root: string, home: string, tool: string, input: Record<string, unknown>): string | undefined => {
  const who = agentOf(agent, plugin)
  if (who === null || !(GUARDED as readonly string[]).includes(tool)) return undefined
  const main = resolve(root, '/', home)
  if (main === null) throw new Error(`cannot place the project root ${root}`)
  const worktree = worktreeOf(home, main, who.ticket, who.role)
  if (tool === 'Bash') {
    const bad = misplacedGit(String(input.command ?? ''), main, home, worktree)
    if (bad === undefined) return undefined
    return `git ${bad[0]} ${bad[1] === null ? 'cannot be placed' : `in ${bad[1]}`}: pipeline agents never change the main checkout. ${how(worktree)}`
  }
  const path = resolve(target(input), main, home)
  if (path === null) return `${tool} to a path that cannot be placed (${JSON.stringify(target(input))}): pipeline agents never change the main checkout. ${how(worktree)}`
  return within(path, main) ? `${tool} in the main checkout (${path}) is refused: pipeline agents never change it. ${how(worktree)}` : undefined
}
