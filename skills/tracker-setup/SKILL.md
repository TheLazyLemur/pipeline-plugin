---
name: tracker-setup
description: Connect the pipeline to this project's ticket tracker and PR host. Finds the MCP servers or CLIs that reach them, agrees the status mapping and writes the project mod .claude/skills/pipeline-tracker/, whose one tracker tool the loop, agents and skills use. Use when setting up the pipeline in a project, switching tracker or PR host, or porting a tracker.md or tracker.sh.
---

# Tracker setup

A conversation with the user. The result is a small project mod, `pipeline-tracker`, in
`.claude/skills/pipeline-tracker/`, where Claude Code loads it automatically and reloads it on change. It registers
one tool, `tracker` (`mcp__pipeline-tracker__tracker`), covering both the tracker and the PR host. The loop, every
pipeline agent, `/learn` and `/pipeline-status` reach the tracker and the PR host through it alone. The mod is the
project's code: the pipeline plugin ships no adapter.

## The contract

One tool, `tracker`, input `{op, ...args}`. Every op is bounded at 30 seconds inside the mod. A failing op answers
`{deny: "<reason>"}`, naming the reason (not connected, auth expired, timed out after 30 s, the host's error); no
retries inside the mod: the loop logs "tracker unreachable: <reason>" and its next pass tries again. A success
answers `{result}`, the value below as a JSON value (never JSON text), `ok` as the string `"ok"`.

| `op` | Input | Returns |
|---|---|---|
| `waiting` | none | `[{id, title, url, body}]` |
| `done` | none | `[{id}]` |
| `blockers` | none | `[{id, blocked_by, blocker_done}]` |
| `mark_done` | `id` | ok |
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

- `id` and `blocked_by` are the tracker's ids, as strings or integers; an `id` given to an op is a string. `url`
  is null when a ticket has none.
- `waiting`: only work items one PR can finish, epics and other parent or container types left out. `body` is the
  description followed by the acceptance criteria (triage judges the ticket from it), null when there is none.
- `done`: every ticket in a done status.
- `blockers`: one row per link from a waiting ticket to a ticket it is blocked by or depends on, `blocker_done`
  true when that ticket is in a done status (true or false; 1 or 0 is accepted). `[]` when the tracker has no links.
- `mark_done`: moves the ticket to the done status, and succeeds when it is already done (some trackers close on
  merge).
- `move`: takes the pipeline's statuses and maps them to the board's, as the README records.
- `pr_create`: the branch is already pushed; the mod runs no git. With `draft: true` it opens a host draft titled
  `Draft: <title>`; on a host without drafts, the prefix alone marks it. `pr_ready` marks the PR ready on the host
  and strips the `Draft: ` prefix, in one call. `head` in `pr_view` is the head commit's sha; `draft` is true while
  either the host draft or the prefix stands; `closed` is true once the PR is closed, merged or not.

## Steps

1. **Find what reaches the tracker and the PR host**, often two systems (Jira and Bitbucket, Linear and GitHub). Ask
   which tracker and board, and which PR host, if it is not obvious. Look for a connected MCP server (`/mcp`), a CLI
   (`gh auth status`, `acli`), an HTTP API with a token in an env var, or anything the user names. Prove each with a
   read-only call. Prefer what the project already uses.
2. **Read the board's statuses** and agree the mapping with the user: which statuses mean waiting to be worked
   (`waiting`), which status `move` uses for `in_progress`, `in_review` and `done`, and which statuses mean done
   (`done`, `blocker_done`).
3. **Port an existing setup.** If `.claude/pipeline/tracker.md` or `.claude/pipeline/tracker.sh` exists, translate
   its commands into the mod's ops: they are commands the user already proved. A script the mod still runs moves into
   the mod's folder. Delete both files once step 5 passes; nothing reads them any more.
4. **Write the mod** in `.claude/skills/pipeline-tracker/`:
   - `.claude-plugin/plugin.json`:
     `{ "name": "pipeline-tracker", "version": "0.1.0", "description": "The pipeline's tracker tool for <tracker> and <PR host>" }`
   - `hooks/hooks.json`: `{ "modules": ["./register.ts"] }`
   - `hooks/register.ts`: registers the tool in `session.start`, awaited before `next`, with `isDeferred: false` so it
     is never behind tool search, and an input schema naming `op` (the sixteen values) and the arguments above.
     One `tool.call` hook on `{ tool: 'mcp__pipeline-tracker__tracker' }` answers it: one function per op, built on
     `$.mcp.call(server, tool, args)` for an MCP server, `$.http.fetch` for an API, `$.process.run(argv)` for a CLI
     (the argv as a list, so no value is ever read as shell text). Race each op against
     `$.clock.sleep(30_000)` and answer `{deny}` on the timeout, on a thrown error, on an MCP result with `isError`,
     on a non-2xx response or a non-zero exit, and on an unknown op. Shape every answer to the contract.
   - `README.md`: the status mapping, and for each op what it calls (server and tool, endpoint, or command), so the
     user can read and adjust what it does.
   - `test/*.test.ts`: the contract tests, one per op, writes included. Each answers the mod's `mcp.call`,
     `http.fetch` and `process.run` requests from saved responses (`on('mcp.call', …)` and the like, beneath the
     mod), checks the server, tool and arguments (or URL and body, or argv) the op sent, and the shape it returned.
     Add a test that an op failing beneath answers `{deny}` naming the reason, and one that an unknown op is denied.
     Nothing in them may reach a real ticket or PR.

   Credentials never go in the mod: it relies on the MCP server's or CLI's own login, or reads a token from an env
   var it names (`$.env.get`).
5. **Check it.** Run each read op live once, through the tool once the mod has loaded (when the tool is not listed
   yet, ask the user to restart the session and carry on from this step): `waiting`, `done`, `blockers`, `read` on a ticket the
   user names, `pr_view` and `pr_merged` on one merged and one open PR. Never run a write op against a real ticket or
   PR while checking: writes are first exercised live on the first real ticket. Keep the live responses as the
   contract tests' saved responses. Then run `claude plugin validate .claude/skills/pipeline-tracker` and
   `claude plugin test .claude/skills/pipeline-tracker`. Nothing is saved until both the live check and the tests
   pass: fix the mod and check again.
6. **Ask the user** whether to commit the mod (the team loads it too), add `.claude/skills/pipeline-tracker/` to
   the project's `.gitignore`, or keep it to this clone through `.git/info/exclude`. Do what they choose.
7. **Copy the defaults** `readiness.md`, `rubric.md` and `routing.md` from this skill's `defaults/` folder into
   `.claude/pipeline/`, skipping any that already exist. Show them to the user and offer to adjust them. Add
   `.claude/pipeline/pipeline.db` to the project's `.gitignore`.

Without the mod, each loop pass logs "no pipeline tracker tool here; run /tracker-setup" and skips the merge check,
sync and mark-done; triage and the agents' stages still run. A new tracker or PR host means running this skill
again; it rewrites the mod only.
