# Tracker mod

## Problem Statement

The pipeline reaches a project's tracker and PR host through shell: `tracker.md` holds `sh -c` commands the loop
runs, and copy-paste instructions the agents follow, and the agents call the PR host's CLI (`gh pr …`) directly.
Many people, at Warp in particular, reach Jira, Linear or GitHub only through MCP servers (the Atlassian MCP, a
GitHub MCP), with no CLI or API token to shell out with. For them the pipeline cannot be set up at all. Even where
shell works, every agent prompt hard-codes one host's CLI, and each agent composes its own tracker calls from prose.

## Solution

`/tracker-setup` writes a small project mod, `pipeline-tracker`, into `<project>/.claude/skills/pipeline-tracker/`,
where it loads automatically. The mod registers one `tracker` tool covering both the tracker and the PR host. Setup's
agent implements each operation with whatever reaches them: MCP calls, HTTP, or shell (the mod may run `gh` inside).
The loop, every pipeline agent, `/learn` and `/pipeline-status` use only that tool, so a project whose tracker and PR
host are MCP-only works exactly like one with a CLI. `tracker.md` and `tracker.sh` go away; existing projects are
ported by running `/tracker-setup` again.

## User Stories

1. As a user whose tracker is reachable only through an MCP server, I want the pipeline to work with it, so that I can use the pipeline without a CLI or API token.
2. As a user whose PR host is reachable only through an MCP server, I want agents to open, review and finish PRs through it, so that source control is not the step that forces a CLI.
3. As a user, I want `/tracker-setup` to find the MCP servers or CLIs that reach my tracker and PR host and check they are connected, so that setup starts from what I already have.
4. As a user with the tracker and the PR host on different systems (Jira and Bitbucket, Linear and GitHub), I want one setup to cover both, so that I set the pipeline up once.
5. As a user, I want setup to write the mod for me, so that I never write adapter code.
6. As a user, I want one `tracker` tool with an `op` argument, so that the loop and agents learn one interface.
7. As a user, I want the tool always visible, so that an agent never misses it behind tool search.
8. As a user, I want the tool to speak the pipeline's statuses (`in_progress`, `in_review`, `done`) and the mod to map them to my board's, so that agents never need my tracker's vocabulary.
9. As a user, I want the mapping and every operation's implementation documented in the mod's README, so that I can read and adjust what it does.
10. As a user, I want the loop's sync, merge check and done step to use the tool, so that the loop needs no shell access to my tracker.
11. As a user, I want the loop's operations to return the same shapes as today, so that its behaviour does not change.
12. As a user, I want every pipeline agent to read, move, comment on and link tickets through the tool, so that no agent composes tracker calls from prose.
13. As a user, I want every pipeline agent to create, view, diff, comment on, edit and mark ready PRs through the tool, so that no prompt hard-codes a host's CLI.
14. As a user, I want draft handling inside the mod (host draft plus `Draft: ` title on create, both undone by one `pr_ready`), so that a PR is never left half-ready by an agent forgetting a step.
15. As a user on a host without drafts, I want the mod to rely on the `Draft: ` prefix alone, so that review still works there.
16. As a user, I want `/learn` to read PR comments, general and inline, through the tool, so that it works on any host.
17. As a user, I want `/pipeline-status` to read blockers and save my answers as comments through the tool, so that it works on any tracker.
18. As a user, I want each operation bounded at 30 seconds, so that a hung server cannot stall a loop pass.
19. As a user, I want a failing operation to return an error naming the reason (not connected, auth expired, timeout), so that the log tells me what to fix.
20. As a user, I want a tracker failure logged as "tracker unreachable: …" while the rest of the pass still runs, so that tickets already in the table keep moving.
21. As a user, I want no retries inside the mod, so that a failure surfaces at once and the next pass retries it.
22. As a user, I want setup to write contract tests, one per operation, with the MCP, HTTP and shell calls answered from saved responses, so that the mod is checked without touching real tickets.
23. As a user, I want the read operations checked live once before the mod is saved, and their responses kept as the tests' saved responses, so that the tests match my real tracker.
24. As a user, I want setup never to write to a real ticket or PR while checking, so that my board stays clean.
25. As a user, I want setup to ask whether to commit the mod, gitignore it, or exclude it through `.git/info/exclude`, so that I decide whether my teammates load it.
26. As a user of a project without the mod, I want the loop to log "no pipeline tracker tool here; run /tracker-setup" and skip its tracker steps, so that I know what to do.
27. As a user of a project set up before this change, I want `/tracker-setup` to translate my `tracker.md` or `tracker.sh` into the mod, so that porting keeps the commands I already proved.
28. As a user, I want credentials kept out of the mod, so that committing it leaks nothing.

## Implementation Decisions

- **The project mod.** `/tracker-setup` writes `<project>/.claude/skills/pipeline-tracker/`: a plugin manifest, a hooks module registering the tool and answering it in its `tool.call` hook, a README, and its contract tests. Project mods load automatically and reload on change. It is project code: the pipeline plugin ships no adapter.
- **One tool,** `tracker`, registered with `isDeferred: false`, input `{op, ...args}`. The PR operations are prefixed `pr_`.
- **The contract,** sixteen operations:

  | `op` | Input | Returns |
  |---|---|---|
  | `waiting` | none | `[{id, title, url, body}]`, epics and other container types excluded |
  | `done` | none | `[{id}]` |
  | `blockers` | none | `[{id, blocked_by, blocker_done}]`, or `[]` when the tracker has no links |
  | `mark_done` | `id` | ok; succeeds when the ticket is already done |
  | `read` | `id` | `{id, title, url, body, comments: [{author, at, text}]}` |
  | `move` | `id`, `status` (`in_progress` / `in_review` / `done`) | ok |
  | `comment` | `id`, `text` | ok |
  | `link_pr` | `id`, `url` | ok |
  | `pr_create` | `branch`, `title`, `body`, `draft` | `{url}` |
  | `pr_view` | `url` | `{title, branch, head, draft, merged, closed}` |
  | `pr_merged` | `url` | `{merged: true\|false}` |
  | `pr_diff` | `url` | the diff, as text |
  | `pr_comment` | `url`, `text` | ok |
  | `pr_comments` | `url` | `[{author, at, text, path?, line?}]`, general and inline together |
  | `pr_edit` | `url`, `title?`, `body?` | ok |
  | `pr_ready` | `url` | ok |

  The fields and rules of `waiting`, `done`, `blockers`, `pr_merged` and `mark_done` are today's `tracker.md` contract unchanged (ids as strings or integers, `url` and `body` nullable, `blocker_done` true or false). `git push` stays plain git.
- **Drafts in the mod.** `pr_create` with `draft: true` opens a host draft titled `Draft: <title>`; `pr_ready` marks it ready on the host and strips the prefix in one call. On a host without drafts the prefix alone marks it.
- **Statuses.** `move` takes pipeline statuses; the mod maps them to the board's, and the README records the mapping.
- **Failures.** Each operation is bounded at 30 seconds inside the mod. A failure returns an error naming the reason. No retries inside the mod.
- **The loop** calls the tool through `$.tool.call` (cross-plugin calls are not affected by the nesting rule, docs/adr/0001). The loop's `Deps` gains a `tracker(op, args)` call in place of running `tracker.md` commands; `closeMerged` and `sync` take it and keep their validation of every result. A missing `tracker` tool replaces the missing-`tracker.md` check: the pass logs "no pipeline tracker tool here; run /tracker-setup" and skips the merge check, sync and mark-done, while `readiness.md`, `rubric.md` and `routing.md` stay in `.claude/pipeline/` and are still required. A tool error is caught as tracker failures are today and logged "tracker unreachable: …".
- **Agents.** The implementer, reviewer, verifier and fixer prompts replace every `gh pr …` command and every reference to `tracker.md` with the `tracker` ops. Using the tool is a prompt rule; no guard refuses direct CLI calls. The `tool.check` allow in `pipeline-agents` already covers the loop's agents' calls.
- **Skills.** `/learn` reads PR comments with `pr_comments`. `/pipeline-status` reads blockers and comments answers through the tool. `/tracker-setup` is rewritten:
  1. Find the MCP servers or CLIs reaching the tracker and the PR host (often two) and check they are connected.
  2. Read the board's statuses and agree the mapping with the user.
  3. If the project has a `tracker.md` or `tracker.sh`, translate its commands into the mod.
  4. Write the mod, its README and its contract tests.
  5. Run the live read-only check (`waiting`, `done`, `blockers`, `read`, `pr_view`, `pr_merged`), keeping the responses as the tests' saved responses, then run the contract tests with `claude plugin test`. Nothing is saved until both pass.
  6. Ask whether to commit the mod, gitignore it, or exclude it through `.git/info/exclude`.
  7. Copy the default `readiness.md`, `rubric.md` and `routing.md` as today, and gitignore `pipeline.db`.
- **Contract tests** (written by setup, in the mod): one per operation, writes included, answering the mod's `mcp.call`, `http.fetch` and `process.run` requests from saved responses, and checking the server, tool and arguments sent and the shape returned. Writes are first exercised live on the first real ticket.
- **Credentials** never go in the mod: it relies on the MCP server's own login or names the env var.
- **Removed:** `tracker.md`, `tracker.sh`, and the code that parses `tracker.md` headings. No compatibility code.
- **Porting:** after this merges, this repo (local SQLite tracker, GitHub) and amrod (Jira, Bitbucket) are ported by running `/tracker-setup` again.

## Testing Decisions

- Test the loop's behaviour, not the engine or any one tracker.
- **The loop, through `pass`,** with a fake `tracker` in `Deps` in place of today's `sh -c` stubs: the existing `sync.spec.ts` and `loop.spec.ts` cases keep their meaning. New cases: with no tracker tool the pass logs "run /tracker-setup" and skips the tracker steps; a tracker error logs "tracker unreachable" and the rest of the pass runs; a malformed op result is rejected as today.
- **Prompts, through `prompts.spec.ts`:** no agent prompt, `/learn` or `/pipeline-status` contains a `gh pr` command or names `tracker.md`; each agent prompt names the `tracker` ops it uses.
- **One `claude plugin test`** with a stand-in `tracker` mod: the loop's `$.tool.call` reaches it, and an agent spawned by `pipeline` calls it, both through the engine, proving a project mod's tool answers both despite docs/adr/0001.
- The generated mod's contract tests belong to each project and are written by setup; the setup skill is instructions and has no test here.
- Prior art: `pipeline-agents/test/report-result.test.ts` (calling a tool from a loop-spawned agent through the engine), the `deps` stub and `freshProject` in the loop tests, `test/prompts.spec.ts`.

## Open Questions

None from the discussion.

## Out of Scope

- Guarding against agents calling a host CLI directly.
- Retries inside the mod.
- A live check of write operations during setup.
- Operations beyond the sixteen; more are added when a host shows a need.
- Compatibility with `tracker.md` or `tracker.sh`.

## Further Notes

- Replaces ticket 20's recommended shape (one `tracker.sh` with fixed subcommands and contract tests); its contract tests carry over into the mod.
- Agent prompt changes reach a running session only after a restart (ticket 25).
- The worktree guard (ticket 26) refuses state-changing git in the main checkout; `pr_create` takes a branch already pushed from the agent's worktree, so the mod itself runs no git.
