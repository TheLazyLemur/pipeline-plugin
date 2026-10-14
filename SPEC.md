# Pipeline: spec

Route each ticket to the right model, let it ship its own PR, and learn from what reviewers say.

## The workflow

You open Claude to spec, plan and review. Triage and implementation run on their own in a loop, and only
pull you in when they need you.

1. You spec and plan with Claude; tickets land in the tracker.
2. The loop picks them up: Haiku triages, the routed model implements and opens its own PR. Merged PRs mark their tickets done, which releases tickets they were blocking.
3. You review PRs, answer anything marked needs_human, and run `/learn`.

## The loop runs in the background (a small mod)

You keep the main thread for spec, plan and review. The loop must never take it over, so it is not the
built-in `/loop`. It is a small mod (`hooks/register.ts`) that runs in the background of the same session:

- A timer (`$.clock.every`, the first pass 10 seconds after session start, then every 5 minutes) runs one pass
  of the loop. Timers fire while the session is idle. A pass that is still running makes the next tick a no-op.
- Triage calls Haiku directly (`$.model.complete`), off the main thread.
- Implementation is a background subagent (`$.agent.spawn` with the routed model), off the main thread.
- SQLite and the tracker.md commands are run with `$.process.run`, from the project root.
- Without `.claude/pipeline/tracker.md`, `readiness.md`, `rubric.md` and `routing.md` a pass only logs
  "run /tracker-setup".

One pass of the loop (`src/loop.ts`), in order:
1. Done: each `pr_open` ticket whose PR has merged is marked done in the tracker and in the table, so sync
   releases its dependents in the same pass.
2. Sync: pull new and changed tickets into SQLite (`src/sync.ts`, TypeScript).
3. Triage every ticket with status new, with the ticket body (`src/triage.ts`). A ticket whose triage fails stays
   new and is retried next pass.
4. Stages: an `in_progress` ticket with no live agent of its own moves on. At stage `review` the reviewers are
   done, so it goes to `verify` and the verifier is spawned; at any other stage its agent is gone without a
   result, so it goes to needs_human.
5. Spawn: if no ticket is in_progress (at any stage), spawn the implementer for the oldest ready one, at stage
   `implement`, telling it whether to open the PR as a draft. If the spawn is denied, the ticket goes back to
   ready and the loop retries next pass.
6. Never wait on a human. Anything that needs one is set to needs_human with the question, and the loop
   moves on.

### The tracker.md command contract
The mod runs these tracker.md commands itself. Each is the first fenced block under a heading spelled exactly
as below, run with `sh -c` from the project root. A tracker.md missing any of them, or a command that exits
non-zero or prints another shape, fails the whole pass with "run /tracker-setup".

| heading | prints |
|---|---|
| `## List the tickets waiting to be worked` | JSON array of `{id, title, url, body}`; `body` is the description plus acceptance criteria; epics are filtered by the command |
| `## List the tickets that are done` | JSON array of `{id}` |
| `## List the blockers` | JSON array of `{id, blocked_by, blocker_done}`, one row per link from a waiting ticket; `[]` when the tracker has no links |
| `## Check whether a PR is merged` | `{"merged": true}` or `{"merged": false}`; gets the PR URL as `$1` |
| `## Mark a ticket done` | nothing; gets the tracker ticket id as `$1`, must succeed when it is already done |

`$1` is passed as an argument (`sh -c '<command>' sh <value>`), never spliced into the command text.
The agents and skills also follow the rest of tracker.md (read a ticket, move a status, add a comment, link a PR,
the status mapping). Design: `docs/specs/dependency-flow.md`.

### Blocked tickets
A waiting ticket with a blocker that is not done is held: sync does not insert it, and removes it while it is
`new` or `ready`. A held ticket has no row and no status. It enters the table once its blockers are done.
`/pipeline-status` lists held tickets live from the blockers command.

### Two plugins
A plugin's hooks never run for agents that the same plugin spawned from its own code, and every pipeline agent is
spawned from the loop's timer (`docs/adr/0001`). So the repo ships two plugins. `pipeline` (the repo root) runs the
loop: the timer, sync, triage, spawning every agent, and the notice filter. `pipeline-agents` (`pipeline-agents/`)
holds every hook that must hear those agents: `report_result`, the `pipeline.db` guard, the `tool.check` allow and
the `SubagentStop` guard. It recognises them as agents spawned by `pipeline`. The code both use (the store, agent
identity, results, the review threshold) lives in `pipeline-agents/src/`, since a plugin can import only from inside
its own folder; `src/` holds the loop's own code. `pipeline` declares `pipeline-agents` under `dependencies`.

### The agents' results
The `pipeline-agents` plugin registers a `report_result` tool (`mcp__pipeline-agents__report_result`, schema `{status: "pr_open" | "reviewed"
| "blocked", pr_url?, findings?, question?}`). The implementer, the verifier and the fixer finish by calling it and
never touch the database: a second `tool.call` hook refuses any Bash command of the loop's agents that mentions
`pipeline.db`, pointing them at the tool (tracker.db and every other file still run). The tool's `tool.call` hook
(`src/result.ts`) refuses any caller that is not one of the loop's own agents, the reviewers (they do not report), a status the caller's role does not send, and a call missing
`pr_url` for pr_open, `findings` for reviewed or `question` for blocked. It writes the ticket:

| reporter | result | ticket |
|---|---|---|
| implementer | pr_open, difficulty below the review threshold, or a ticket started before stages (null stage) | `pr_open` with `pr_url` |
| implementer | pr_open, difficulty at or above the threshold | stage `review` with `pr_url`; the next pass spawns both reviewers |
| verifier | reviewed, 0 findings | `pr_open` |
| verifier | reviewed, more than 0 findings | stage `fix`; the next pass spawns the fixer |
| fixer | pr_open | `pr_open` with `pr_url` |
| any | blocked | `needs_human` with `question` |

The write applies only while the ticket is `in_progress` at the reporter's stage. A stage it moves the ticket into
is left with `started = 0`; the loop's next pass spawns that stage's agents and sets `started = 1`, so a pass never
takes an unstarted stage for finished. The hook does not spawn them itself: an agent spawned from `pipeline-agents`
would be nested in it, and its own calls would skip these hooks (`docs/adr/0001`). A `classic.SubagentStop` hook blocks an implementer, verifier or
fixer whose ticket is still at its stage from stopping once, with a reason telling it to call the tool; if it stops
again, the ticket goes to needs_human. The stage check in each pass covers an agent that crashes or is killed. The
implementer and the fixer work in their own git worktree, so they never switch branches in the checkout you are
using.

### Agent review (difficulty at or above the review threshold)
Design: `docs/specs/agent-review.md`. The threshold is routing.md's `Review threshold: <n>` line (3 when the line is
missing). Such a ticket's implementer opens its PR with a `Draft: ` title prefix. Then, all at status
`in_progress`, the `stage` column moves `implement` → `review` → `verify` → (`fix`) and each stage's agents run:

- `reviewer-spec` and `reviewer-quality`, read-only, on the model one tier above the routed one (sonnet → opus,
  opus → fable, fable → fable): each reads the ticket, any spec it references and the PR at its head commit, and
  posts its findings as one ticket comment.
- `verifier`, on the same tier: checks each finding against the code, drops false ones, merges duplicates, posts
  the checked list on the ticket and the PR, removes the `Draft: ` prefix when none are left, and reports the count.
- `fixer`, on the routed model: addresses the checked findings on the same branch and PR, comments on the PR what
  it fixed and why not the rest, removes the `Draft: ` prefix and reports.

One round only. Every stage is read from the table and the live agents each pass, so a reload or restart picks up
where it was. An agent that cannot be spawned sends the ticket to needs_human with the PR still a draft.

### Permissions and notices
The loop's agents run unattended. A `tool.check` hook allows every tool call of the loop's agents (described
`pipeline <ticket>` for the implementer, `pipeline <ticket> <role>` for the review agents)
that would otherwise prompt. Deny rules and an organization ceiling still apply, so keep `git push --force` and
PR merges denied in settings if merging should stay with you. A `prompt.submit` hook drops the completion
notice of those agents, which would start a turn on the main thread; you still see a one-line log per event.

### Needing you
A ticket goes to needs_human when triage finds it not ready (missing acceptance criteria, open questions),
the implementer is blocked or ends without a result, or its implementer disappears. The question is stored on
the ticket. `/pipeline-status` in your session lists them; your answer is saved as a comment on the tracker
ticket and it goes back to new or ready.

## Pieces

### `/tracker-setup` (skill)
A conversation between the user and Claude. Claude finds what is available for this project's tracker
(an MCP server, `gh`, a Jira API key, anything else), reads the board's statuses, and writes
`.claude/pipeline/tracker.md`: the five commands above, plus how to read one ticket, move a status, add a
comment and link a PR, and the status mapping. It then copies the defaults for `readiness.md`, `rubric.md` and
`routing.md` from `skills/tracker-setup/defaults/` into `.claude/pipeline/` when absent. No adapter code. A new
tracker means running this skill again. A tracker reachable only through an MCP server, with no CLI or HTTP API,
cannot be synced, because the mod runs the commands itself.
Credentials stay in env vars or the tool's own login, never in the file.

### `/pipeline-status` (skill)
Shows counts by status, tickets in progress with their stage and open PRs, held tickets and what holds each (a dependency cycle
shows as tickets holding each other), then walks you through the needs_human questions and saves each answer.

### SQLite (`.claude/pipeline/pipeline.db`)
Holds pipeline status. The tracker owns the ticket itself; SQLite holds our fields.

| column | |
|---|---|
| ticket_id | the tracker's id |
| title, url | copied from the tracker |
| body | the description plus acceptance criteria, copied from the tracker by sync for triage |
| status | new, needs_human, ready, in_progress, pr_open, done |
| stage | implement, review, verify or fix, while in_progress; null (from before stages) reads as implement |
| question | what it needs from you, when needs_human |
| difficulty | 1-5 |
| confidence | 0-1 |
| model | haiku, sonnet, opus or fable |
| reason | why the score / why not ready |
| pr_url | |
| learned | whether /learn has processed the PR |

Read and written with the `sqlite3` CLI.

### Triage (`src/triage.ts`, not a skill)
For each new ticket, Haiku checks readiness against `.claude/pipeline/readiness.md`, scores difficulty against
`.claude/pipeline/rubric.md` and picks the model from `.claude/pipeline/routing.md`, in one call, from the
title, URL and body. Writes status, difficulty, confidence, model and reason.

### Routing (`.claude/pipeline/routing.md`)
A short table: difficulty to model. Example: 1-2 sonnet, 3-4 opus, 5 fable. Security-critical goes to fable.
Applied by Haiku at triage, not by a parser, and only to sonnet, opus or fable, the models with an implementer.
Its `Review threshold: <n>` line is read by the mod: the difficulty at and above which a ticket gets agent review.

### Implementers (`agents/implementer-sonnet.md`, `-opus.md`, `-fable.md`)
Spawned by the loop for the routed model. Each reads the ticket, works in its own worktree, implements it, runs the
tests, opens its own PR and links it on the tracker using tracker.md. It finishes by calling `report_result`, described above. Its prompt says whether to open the PR with the `Draft: `
title prefix.

### Review agents (`agents/reviewer-spec.md`, `reviewer-quality.md`, `verifier.md`, `fixer.md`)
One file per role; the model is passed at spawn. Described above under agent review.

### `/learn` (skill)
Finds PRs in SQLite with learned = false. For each, reads the review comments and works through them
with the human: what went wrong and which file should change so it does not happen again —
CLAUDE.md, rules, the implementer prompts, readiness.md, rubric.md or checklists. The human approves
each change. Marks the PR learned.

## Not in this version
Leases, a separate inbox (the needs_human status covers it), calibration dashboards, status band, guards, worktree management by the mod (the implementer makes its own). The mod runs the loop and nothing else.
Add any of these only when a real need shows up.
