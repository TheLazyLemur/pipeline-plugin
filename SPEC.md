# Pipeline: spec (v2, simple)

Route each ticket to the right model, let it ship its own PR, and learn from what reviewers say.

## The workflow

You open Claude to spec, plan and review. Triage and implementation run on their own in a loop, and only
pull you in when they need you.

1. You spec and plan with Claude; tickets land in the tracker.
2. The loop picks them up: Haiku triages, the routed model implements and opens its own PR.
3. You review PRs, answer anything marked needs_human, and run `/learn`.

## The loop runs in the background (a small mod)

You keep the main thread for spec, plan and review. The loop must never take it over, so it is not the
built-in `/loop`. It is a small mod that runs in the background of the same session:

- A timer (`$.clock.every`, every few minutes) runs one pass of the loop. Timers fire while the session is idle.
- Triage calls Haiku directly (`$.model.complete`), off the main thread.
- Implementation is a background subagent (`$.agent.spawn` with the routed model), off the main thread.
- SQLite is read and written with `sqlite3` through `$.process.run`.

One pass of the loop:
1. Sync: pull new and changed tickets into SQLite, following tracker.md.
2. Triage every ticket with status new.
3. If no ticket is in_progress, spawn the implementer for the next ready one.
4. Never wait on a human. Anything that needs one is set to needs_human with the question, and the loop
   moves on.

To verify first: that `$.agent.spawn` runs the implementer in the background without blocking the main thread.

### Needing you
A ticket goes to needs_human when triage finds it not ready (missing acceptance criteria, open questions)
or the implementer gets blocked. The question is stored on the ticket. `/pipeline-status` in your session
lists them; your answer is saved to the ticket and it goes back to new or ready.

## Pieces

### `/tracker-setup` (skill)
A conversation between the user and Claude. Claude finds what is available for this project's tracker
(an MCP server, `gh`, a Jira API key, anything else), reads the board's statuses, and writes
`.claude/pipeline/tracker.md`: how to list tickets, read one, move a status, and link a PR, plus the
status mapping. No adapter code. A new tracker means running this skill again.
Credentials stay in env vars or the tool's own login, never in the file.

### SQLite (`.claude/pipeline/pipeline.db`)
Holds pipeline status. The tracker owns the ticket itself; SQLite holds our fields.

| column | |
|---|---|
| ticket_id | the tracker's id |
| title, url | copied from the tracker |
| body | the description plus acceptance criteria, copied from the tracker for triage |
| status | new, needs_human, ready, in_progress, pr_open, done |
| question | what it needs from you, when needs_human |
| difficulty | 1-5 |
| confidence | 0-1 |
| model | haiku, sonnet, opus or fable |
| reason | why the score / why not ready |
| pr_url | |
| learned | whether /learn has processed the PR |

Read and written with the `sqlite3` CLI.

### `/triage` (skill)
For each ticket not yet scored: Haiku checks readiness against `.claude/pipeline/readiness.md` and scores
difficulty against `.claude/pipeline/rubric.md`. Writes status, difficulty, confidence, reason.

### Routing (`.claude/pipeline/routing.md`)
A short table: difficulty to model. Example: 1-2 sonnet, 3-4 opus, 5 fable. Security-critical goes to fable.

### `/work` (skill)
Takes the next ready ticket, spawns the implementer subagent for its model
(`agents/implementer-sonnet.md`, `-opus.md`, `-fable.md`), which implements it, runs the tests and opens
its own PR. Writes pr_url and status, and moves the tracker status using tracker.md.

### `/learn` (skill)
Finds PRs in SQLite with learned = false. For each, reads the review comments and works through them
with the human: what went wrong and which file should change so it does not happen again —
CLAUDE.md, rules, the implementer prompts, readiness.md, rubric.md or checklists. The human approves
each change. Marks the PR learned.

## Not in this version
Leases, a separate inbox (the needs_human status covers it), calibration dashboards, status band, guards, worktree management. The mod runs the loop and nothing else.
Add any of these only when a real need shows up.
