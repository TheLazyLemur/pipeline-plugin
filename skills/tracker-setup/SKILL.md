---
name: tracker-setup
description: Connect the pipeline to this project's ticket tracker and PR host. Finds the MCP servers or CLIs that reach them, agrees the status mapping and writes the project mod .claude/skills/pipeline-tracker/, whose one tracker tool the loop, agents, skills and CLI use. Use when setting up the pipeline in a project, switching tracker or PR host, or porting a tracker.md or tracker.sh.
---

# Tracker setup

A conversation with the user. The result is a small project mod, `pipeline-tracker`, in
`.claude/skills/pipeline-tracker/`, where Claude Code loads it automatically and reloads it on change. It registers
one tool, `tracker` (`mcp__pipeline-tracker__tracker`), covering both the tracker and the PR host, and one command,
`/pipeline-tracker <op> <json args>`, that runs the same ops outside a session. The loop, every pipeline agent,
`/learn`, `/pipeline-status` and the CLI (`bin/pipeline.ts`) reach the tracker and the PR host through it alone. The
mod is the project's code: the pipeline plugin ships no adapter.

## The contract

One tool, `tracker`, input `{op, ...args}`. Every op is bounded at 30 seconds inside the mod. A failing op answers
`{deny: "<reason>"}`, naming the reason (not connected, auth expired, timed out after 30 s, the host's error); no
retries inside the mod: the loop logs "tracker unreachable: <reason>" and its next pass tries again. A success
answers `{result}`, the value below as a JSON value (never JSON text), ok as the string `"ok"`.

| `op` | Input | Returns |
|---|---|---|
| `waiting` | none | `[{id, title, url, body}]` |
| `done` | none | `[{id}]` |
| `blockers` | none | `[{id, blocked_by, blocker_done}]` |
| `mark_done` | `id` | ok |
| `create` | `title`, `body` | `{id, url}` |
| `link_blocker` | `id`, `blocked_by` | ok |
| `read` | `id` | `{id, title, url, body, comments: [{author, at, text}]}` |
| `move` | `id`, `status` (`in_progress` / `in_review` / `done`) | ok |
| `comment` | `id`, `text` | ok |
| `link_pr` | `id`, `url` | ok |
| `pr_create` | `branch`, `title`, `body`, `draft`, `base?` | `{url}` |
| `pr_view` | `url` | `{title, branch, head, draft, merged}` |
| `pr_merged` | `url` | `{merged: true}`, `{merged: false}` (open) or `{merged: false, closed: true}` |
| `pr_diff` | `url` | the diff, as text |
| `pr_comment` | `url`, `text` | ok |
| `pr_comments` | `url` | `[{author, at, text, path?, line?}]`, general and inline together |
| `pr_edit` | `url`, `title?`, `body?` | ok |
| `pr_ready` | `url` | ok |
| `pr_restack` | `url` | ok |

- `id` and `blocked_by` are the tracker's ids, as strings or integers; an `id` given to an op is a string. Each must
  be one path segment, because the pipeline names every agent's worktree `<id>-<role>`: it matches
  `^[A-Za-z0-9_.@+-]+$` and is neither `.` nor `..`. So `42` or `APS-756`, never `owner/repo#42` or a URL: return
  the tracker's short id, not a reference to it. The rule is `TICKET` and `bad()` in `pipeline-agents/src/guards.ts`;
  if those change, change it here too. `url` is null when a ticket has none.
- `waiting`: only work items one PR can finish, epics and other parent or container types left out. `body` is the
  description followed by the acceptance criteria (triage judges the ticket from it), null when there is none.
- `done`: every ticket in a done status.
- `blockers`: one row per link from a waiting ticket to a ticket it is blocked by or depends on, `blocker_done`
  true when that ticket is in a done status (true or false; 1 or 0 is accepted). `[]` when the tracker has no links.
- `mark_done`: moves the ticket to the done status, and succeeds when it is already done (some trackers close on
  merge).
- `create`: creates the ticket in a waiting status, so the next sync pulls it in; `body` is markdown. `id` is a
  string that matches the id rule.
- `link_blocker`: records that `id` is blocked by `blocked_by`, so `blockers` then returns
  `{id, blocked_by, ...}` for it.
- `move`: takes the pipeline's statuses and maps them to the board's, as the README records.
- `read`, `waiting` and `pr_comments` return markdown or plain text, never a tracker's rich format, and `comment`
  and `create` take markdown: on Jira, convert ADF to text on the way in and markdown to ADF on the way out.
- `pr_create`: the branch is already pushed; the mod runs no git. `base` is the head branch of the PR to stack on;
  without it the PR goes on the default branch. With `draft: true` it opens a host draft titled `Draft: <title>`;
  on a host without drafts, the prefix alone marks it. `pr_ready` marks the PR ready on the host and strips the
  `Draft: ` prefix, in one call. `branch` in `pr_view` is the PR's head branch, `head` its head commit's sha; `draft`
  is true while either the host draft or the prefix stands.
- `pr_restack`: brings the PR's branch up to date with its base on the host, succeeds when it is already up to
  date, and fails on a conflict, naming it. It touches no local checkout (the loop runs it from the user's main
  checkout) and never force-pushes.

## Steps

1. **Find what reaches the tracker and the PR host**, often two systems (Jira and Bitbucket, Linear and GitHub). Ask
   which tracker and board, and which PR host, if it is not obvious. Look for a connected MCP server (`/mcp`), a CLI
   (`gh auth status`, `acli`), an HTTP API with a token in an env var, or anything the user names. Prove each with a
   read-only call. Prefer what the project already uses, and its own helpers for that tracker (a Jira client, a
   `gh` wrapper) over new requests. Ask whether the user wants stacked PRs (a PR whose base is another PR's branch,
   retargeted when that one merges) and whether the PR host supports them: they need `pr_create`'s `base` and
   `pr_restack`. Without them, both answer `{deny}` naming that, and step 7 leaves stacking off.
2. **Read the board's statuses** and agree the mapping with the user: which statuses mean waiting to be worked
   (`waiting`, and the status `create` puts a new ticket in), which status `move` uses for `in_progress`,
   `in_review` and `done`, and which statuses mean done (`done`, `blocker_done`).
3. **Port an existing setup.** If `.claude/pipeline/tracker.md` or `.claude/pipeline/tracker.sh` exists, translate
   its commands into the mod's ops: they are commands the user already proved. Its sections map to ops by name
   (`## List the tickets waiting to be worked` is `waiting`, `## Check whether a PR is merged` is `pr_merged`,
   `## Bring a stacked PR up to date` is `pr_restack`, and so on); its read, move, comment and link-PR
   instructions become `read`, `move`, `comment` and `link_pr`. A script the mod still runs moves into the mod's
   folder, with its contract tests. Delete both files once step 5 passes; nothing reads them any more.
4. **Write the mod** in `.claude/skills/pipeline-tracker/`:
   - `.claude-plugin/plugin.json`:
     `{ "name": "pipeline-tracker", "version": "0.1.0", "description": "The pipeline's tracker tool for <tracker> and <PR host>" }`
   - `hooks/hooks.json`: `{ "modules": ["./register.ts"] }`
   - `hooks/register.ts`. In `session.start`, before `next`, register the tool with `$.tool.register`, with
     `isDeferred: false` so it is never behind tool search and an input schema naming `op` (the nineteen values) and
     the arguments above, and register the command with
     `$.command.register({ name: 'pipeline-tracker', description: '…', argumentHint: '<op> <json args>' })`.
     Write one function per op, built on `$.mcp.call(server, tool, args)` for an MCP server, `$.http.fetch` for an
     API, or `$.process.run(argv)` for a CLI, the argv a list so no value is ever read as shell text. Race each op
     against `$.clock.sleep(30_000)`, and fail on the timeout, on a thrown error, on an MCP result with `isError`,
     on a non-2xx response or a non-zero exit, and on an unknown op. Shape every success to the contract. Then:
     - one `tool.call` hook on `{ tool: 'mcp__pipeline-tracker__tracker' }` answers `{result}`, or `{deny}` naming
       the reason;
     - one `command.run` hook on `{ command: 'pipeline-tracker' }` takes the op as the first word of `e.args` and
       the rest as its JSON arguments (none is `{}`), and answers `{text: JSON.stringify(result), exitCode: 0}`, or
       `{text: reason, exitCode: 1}`, without calling `next`, so no model turn runs.
   - `README.md`: the status mapping, and for each op what it calls (server and tool, endpoint, or command), so the
     user can read and adjust what it does.
   - `test/*.test.ts`: the contract tests, one per op, writes included. Each answers the mod's `mcp.call`,
     `http.fetch` and `process.run` requests from saved responses (`on('mcp.call', …)` and the like, beneath the
     mod), checks the server, tool and arguments (or URL and body, or argv) the op sent, and the shape it returned.
     Add a test that an op failing beneath answers `{deny}` naming the reason, one that an unknown op is denied,
     and one that `/pipeline-tracker` answers an op's result with exit code 0 and a failure with 1. Nothing in them
     may reach a real ticket or PR.

   Credentials never go in the mod: it relies on the MCP server's or CLI's own login, or reads a token from an env
   var it names (`$.env.get`).
5. **Check it.** Run each read op live once, through the tool once the mod has loaded (when the tool is not listed
   yet, ask the user to restart the session and carry on from this step): `waiting`, `done`, `blockers`, `read` on a
   ticket the user names, `pr_view` on an open PR, and `pr_merged` on one merged and one open PR, and one closed
   without merging if there is one. Check that every `id` and `blocked_by` in them follows the id rule, while at
   least one ticket waits and one link exists. Run `claude -p "/pipeline-tracker waiting"` from the project root
   once too, which proves the CLI's way in. Never run a write op against a real ticket or PR while checking: writes
   are first exercised live on the first real ticket. Keep the live responses as the contract tests' saved
   responses. Then run `claude plugin validate .claude/skills/pipeline-tracker` and
   `claude plugin test .claude/skills/pipeline-tracker`. Nothing is saved until both the live check and the tests
   pass: fix the mod and check again.
6. **Ask the user** whether to commit the mod (the team loads it too), add `.claude/skills/pipeline-tracker/` to
   the project's `.gitignore`, or keep it to this clone through `.git/info/exclude`. Do what they choose.
7. **Copy the defaults** `readiness.md`, `rubric.md` and `routing.md` from this skill's `defaults/` folder into
   `.claude/pipeline/`, skipping any that already exist. Show them to the user and offer to adjust them. With
   stacked PRs on (step 1), set routing.md's `Stack depth:` to the most unmerged PRs a stack may hold, counting its
   bottom one (2 lets one ticket build on one open PR). Add `.claude/pipeline/pipeline.db` to the project's
   `.gitignore`.

## Per host

- **GitHub**, through `gh`: `pr_create` is `gh pr create --head <branch> --title … --body-file - [--base <base>]
  [--draft]`; `pr_view` reads `gh pr view <url> --json title,headRefName,headRefOid,isDraft,state`; `pr_merged` is
  `gh pr view <url> --json state` (`CLOSED` is `{merged: false, closed: true}`); `pr_comments` joins
  `gh pr view <url> --json comments,reviews` and `gh api repos/{owner}/{repo}/pulls/<n>/comments`; `pr_ready` is
  `gh pr ready <url>`, then `gh pr edit <url> --title <title without the prefix>`. For issues as tickets, `create`
  is `gh issue create` with the waiting label, and `link_blocker` posts the issue dependencies API, which takes the
  blocking issue's numeric `.id`, not its number:
  `gh api -X POST repos/{owner}/{repo}/issues/<id>/dependencies/blocked_by -F issue_id=<the blocker's .id>`.
  Stacked PRs use the `github/gh-stack` extension (https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands);
  check it with `gh extension list` and install it only with the user's go-ahead. With `base`, `pr_create` then
  joins the new PR to the base PR's stack with `gh stack link <base PR> <new PR>`, without `--open`, which marks
  every PR in the stack ready. `pr_restack` reads `gh pr view <url> --json mergeStateStatus`: on `BEHIND` it runs
  `gh pr update-branch <url>` (which fails when there is nothing to merge), on `DIRTY` it fails naming the
  conflict, otherwise it is up to date.
- **Jira.** Ask for the project key, the issue type, and the waiting status a new ticket must start in. Read the
  create metadata (`GET /rest/api/3/issue/createmeta/{projectKey}/issuetypes/{issueTypeId}`) for fields that are
  required and have no default, agree a fixed value for each with the user, and put them in the mod. `create`
  posts `/rest/api/3/issue` with `summary` and the body as ADF, transitions the new issue to the waiting status
  when the workflow does not start there, and returns `{id: "<key>", url: "https://<site>/browse/<key>"}`.
  `link_blocker` posts `/rest/api/3/issueLink` with type `Blocks`, `inwardIssue` the blocked ticket and
  `outwardIssue` its blocker; its contract test checks that `blockers` reads such a link back the same way round.
- **A local SQLite tracker**, through `sqlite3`: the `sqlite3` CLI cannot bind values, so check every id against
  the id rule (an integer for an integer key) and double every `'` in a text value before it goes in a statement.
