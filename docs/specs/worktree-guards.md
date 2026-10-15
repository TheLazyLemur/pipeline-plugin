# Worktree guards

## Problem Statement

The pipeline's agents start in the user's own checkout: a subagent's working directory is the session's. Today the
only thing keeping an implementer or fixer from editing files or switching branches there is a line in its prompt
("work in a fresh git worktree, never touch the main checkout"), and implementers have already broken prompt rules
(ticket 6 wrote pipeline.db, ticket 11 ignored the PR skill). Worktree locations also vary (a sibling folder, the
session scratchpad, any path), so nothing could check them. One agent running `git checkout` or a bare `git commit`
in the user's checkout would disrupt the work the user is doing while the loop runs.

## Solution

Every agent the loop spawns works in a worktree at a path the loop chooses, outside the project:
`~/.claude/pipeline-worktrees/<project>/<ticket>-<role>`. A guard in `pipeline-agents` refuses those agents' file
edits inside the main checkout, and their state-changing git commands unless the command explicitly targets their
own worktree. It fails closed: what it cannot place, it refuses, with a message naming the worktree to use. When a
ticket is done, the loop removes anything left under its worktree paths. The user's checkout is never changed by a
pipeline agent, whatever its prompt says.

## User Stories

1. As a user, I want pipeline agents unable to edit files in my checkout, so that my working tree only changes when I change it.
2. As a user, I want pipeline agents unable to switch branches, commit, reset, stash, rebase, merge, pull or clean in my checkout, so that the loop cannot disrupt my current work.
3. As a user, I want read-only git (status, log, diff, show, fetch, worktree add/list/remove) to keep working anywhere, so that agents can still inspect the repository and create their worktrees.
4. As a user, I want every agent's worktree at a predictable path outside my project, so that nothing clutters my checkout and I know where to look.
5. As a user, I want the path chosen by the loop and given to the agent, so that the guard knows exactly which folder that agent may change.
6. As a user, I want a restarted agent to get the same worktree path, so that it continues where the last one stopped.
7. As a user, I want the guard to refuse what it cannot place, so that an ambiguous command is stopped rather than allowed.
8. As a user, I want each refusal to name the worktree the agent should use, so that the agent corrects itself on the next call.
9. As a user, I want all the loop's agents guarded, reviewers and verifier included, so that a read-only agent "quickly fixing" something in my checkout is stopped too.
10. As a user, I want `..` and `~` in paths resolved before comparing, so that a relative path cannot slip past the check.
11. As a user, I want worktrees left behind by a dead or stopped agent removed once the ticket is done, so that old worktrees do not pile up.
12. As a user, I want that cleanup limited to the ticket's own worktree paths, so that nothing else on disk is touched.
13. As a user, I want the guard's known gaps written down, so that I know it stops accidents and not deliberate evasion.
14. As a user, I want my main session and agents the pipeline did not spawn untouched by the guard, so that my own work is unaffected.

## Implementation Decisions

- **Protected:** the main checkout, the session's project root (`$.session.root()`). Paths outside it are not the guard's concern.
- **Worktree root:** `~/.claude/pipeline-worktrees/<project>/`, where `<project>` is the project root's folder name. Each agent's worktree is `<root>/<ticket>-<role>`, with role `implementer`, `reviewer-spec`, `reviewer-quality`, `verifier` or `fixer`.
- **The loop chooses the path:** the `pipeline` plugin computes it when it spawns an agent and states it in the spawn prompt. The agent creates the worktree there with `git worktree add`; the implementer and fixer prompts say to use exactly that path. A restarted agent gets the same path.
- **The guard,** in `pipeline-agents` (it hears the loop's agents, docs/adr/0001), on `tool.call` for this plugin's pipeline agents only:
  - **`Edit`, `Write` and `NotebookEdit`:** refused when the resolved target path is inside the main checkout.
  - **`Bash`:** a state-changing git command (`checkout`, `switch`, `reset`, `commit`, `stash`, `rebase`, `merge`, `pull`, `clean`, `restore`, `branch -D`/`-d`, `push` from the checkout) is allowed only when the command text targets the agent's worktree explicitly, by `cd <worktree> && …` or `git -C <worktree> …`. Otherwise it is refused. Read-only git (`status`, `log`, `diff`, `show`, `fetch`, `rev-parse`, `worktree add`, `worktree list`, `worktree remove`) is allowed anywhere.
  - **Fail closed:** a path it cannot make absolute (for example one using `$VAR`) or a git command it cannot place is refused.
  - **The refusal** names the worktree path the agent should use.
  - It sits beside the existing `pipeline.db` guard and follows the same rule: a guard whose own check throws refuses the call.
- **Path resolution:** `.`, `..` and `~` are resolved as text before comparing. Symlinks are not resolved.
- **Cleanup:** agents still remove their own worktree when they finish. When a ticket reaches `done`, the loop also removes every worktree left under `<root>/<ticket>-*` (`git worktree remove --force`, then `git worktree prune`) and touches nothing else.
- **Known gaps, recorded in NOTES.md:** general shell writes (`sed -i`, `>`, `mv`, `rm`, scripts) are not detected; symlinks are not resolved. The guard stops accidents, not deliberate evasion.

## Testing Decisions

- Test the decisions as plain functions and the loop through `pass`; do not test the engine.
- **`pipeline-agents/src/guards.ts`**, node tests:
  - an edit inside the main checkout is refused; one inside the agent's worktree is allowed; one elsewhere on disk is allowed.
  - a bare `git commit` is refused; `git -C <worktree> commit` and `cd <worktree> && git commit` are allowed; `git -C <main checkout> commit` is refused.
  - read-only git is allowed from anywhere.
  - `..` and `~` are resolved; a path with `$VAR` is refused.
  - a non-pipeline agent is not checked.
- **The loop, through `pass`:** the implementer's spawn prompt carries its worktree path; a ticket that reaches `done` has its leftover worktrees removed, using a temporary git repository with a real `git worktree add`, and a worktree of another ticket is left alone.
- **One `claude plugin test`:** a pipeline agent's `Edit` into the main checkout is refused through the engine.
- Prior art: `test/result.spec.ts` (`dbRefusal`), the loop tests' `deps` stub and `freshProject`, and ticket 15's plugin test.

## Open Questions

None from the discussion.

## Out of Scope

- Detecting general shell writes in the main checkout.
- Resolving symlinks.
- Guarding paths outside the main checkout.
- Guarding the main session or agents the pipeline did not spawn.

## Further Notes

- Prompt changes (the worktree path) need a session restart to reach running sessions (ticket 25); the guard itself is code and applies on reload, so it starts refusing before the prompts catch up. Agents on old prompts will then be told the path by the first refusal.
- Builds on docs/adr/0001 (only `pipeline-agents` hears the loop's agents).
