import type { AgentInfo } from 'claude-code'
import { type Role, agentOf } from './agents.ts'

/** Where every pipeline agent's worktree lives, under the user's home: `<home>/.claude/pipeline-worktrees/<project>/<ticket>-<role>`. */
export const WORKTREES = '.claude/pipeline-worktrees'

/** The tools the worktree guard checks. */
export const GUARDED = ['Edit', 'Write', 'NotebookEdit', 'Bash'] as const

/** A ticket id names one path segment; a project folder name is only kept out of `.`, `..`, empty and a `/`. */
const TICKET = /^[\w.@+-]+$/
const bad = (part: string, strict: boolean) => part === '' || part === '.' || part === '..' || part.includes('/') || (strict && !TICKET.test(part))

/** Whether `ticket` can name a worktree, so `worktreeOf` will not throw on it. */
export const namesWorktree = (ticket: string) => !bad(ticket, true)

/** The worktree of `role` for `ticket` of the project at `root`; throws on a ticket id or project name that cannot be one path segment. */
export const worktreeOf = (home: string, root: string, ticket: string, role: Role): string => {
  const project = root.replace(/\/+$/, '').split('/').pop() ?? ''
  for (const [part, strict] of [[project, false], [ticket, true]] as const) if (bad(part, strict)) throw new Error(`cannot name a worktree from ${JSON.stringify(part)}`)
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

/** Git subcommands that change nothing, allowed from anywhere. */
const READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'fetch', 'rev-parse', 'worktree', 'ls-files', 'ls-tree', 'ls-remote', 'blame', 'grep', 'describe', 'cat-file', 'rev-list', 'merge-base', 'reflog', 'version', 'shortlog', 'for-each-ref', 'show-ref', 'name-rev', 'check-ignore', 'diff-tree', 'var', 'count-objects'])
/** Subcommands that change nothing with these arguments: a listing `branch`, `tag`, `stash`, `remote` and a `config` read. */
const READS: Record<string, (args: string[]) => boolean> = {
  branch: args => !args.some(a => /^-[dDmMcCuf]|^--(delete|move|copy|force|set-upstream-to|unset-upstream)/.test(a)),
  tag: args => args.length === 0 || args.includes('-l') || args.includes('--list'),
  stash: args => args[0] === 'list' || args[0] === 'show',
  remote: args => args.length === 0 || args[0] === 'show' || args[0] === 'get-url' || args[0]!.startsWith('-'),
  config: args => args.some(a => a === '-l' || a.startsWith('--get') || a.startsWith('--list')),
}
const readOnly = (sub: string, args: string[]) => READ_ONLY.has(sub) || (READS[sub]?.(args) ?? false)

/** Each simple command of a shell command line, roughly: split on the shell's separators, subshells and substitutions; a word's outer quotes are dropped so `sh -c 'git …'` shows its git. */
const commands = (command: string) =>
  command
    .split(/\|\||&&|[;|&()\n`]/)
    .map(s => s.trim().split(/\s+/).map(w => w.replace(/^["']|["']$/g, '')))
    .filter(w => w[0] !== '')

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
    // git anywhere in the command, so a wrapper the guard does not know (rtk proxy, timeout, sudo, sh -c) fails closed
    let i = words.indexOf('git')
    if (i === -1) continue
    let where = cwd
    for (i++; i < words.length && words[i]!.startsWith('-'); i++) {
      if (words[i] === '-C') where = resolve(words[++i] ?? '', where, home)
      else if (words[i] === '-c') i++
    }
    const sub = words[i]
    if (sub === undefined || readOnly(sub, words.slice(i + 1))) continue
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
    const place = bad[1] === null ? 'cannot be placed' : within(bad[1], main) ? `in ${bad[1]}: pipeline agents never change the main checkout` : `in ${bad[1]}, which is not your worktree`
    return `git ${bad[0]} ${place}. ${how(worktree)}`
  }
  const path = resolve(target(input), main, home)
  if (path === null) return `${tool} to a path that cannot be placed (${JSON.stringify(target(input))}): pipeline agents never change the main checkout. ${how(worktree)}`
  return within(path, main) ? `${tool} in the main checkout (${path}) is refused: pipeline agents never change it. ${how(worktree)}` : undefined
}
