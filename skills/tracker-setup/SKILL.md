---
name: tracker-setup
description: Connect the pipeline to this project's ticket tracker. Finds the tracker tooling, reads the board's statuses and writes .claude/pipeline/tracker.md. Use when setting up the pipeline in a project or switching tracker.
---

# Tracker setup

A conversation with the user. The result is `.claude/pipeline/tracker.md`: the commands the pipeline's mod runs to
sync, and the instructions its agents follow to talk to the tracker. No adapter code in the plugin.

1. **Find the tracker.** Ask which tracker and board or project this repo uses if it is not obvious. Look for what
   can reach it: a connected MCP server, `gh` (run `gh auth status`), `acli` or a Jira API token in an env var, or
   anything else the user names. Try a read-only call to prove it works.
2. **Read the board's statuses** and agree with the user on the mapping:
   - which tracker statuses mean a ticket is waiting to be worked (sync pulls these in as `new`),
   - which status to move a ticket to when the implementer starts, when its PR is open, and which mean done.
3. **Write `.claude/pipeline/tracker.md`.** The pipeline's mod runs five commands itself. Each goes in the
   first fenced code block under its own heading, spelled exactly as below, and is run with `sh -c` from the
   project root. A tracker.md missing any of them stops every loop pass from syncing, logging "tracker unreachable"
   with "run /tracker-setup".

   **Pick the shape.** When the tracker or the PR host is reached through an API (Jira, GitHub, Bitbucket, Linear),
   write one script, `.claude/pipeline/tracker.sh`, with one subcommand per section below: `waiting`, `done`,
   `blockers`, `merged`, `mark-done`, plus `read`, `move`, `comment` and `link-pr` for the agents. Each section
   of tracker.md is then one line calling the script, for example `.claude/pipeline/tracker.sh merged "$1"`.
   Auth, pagination, JSON shaping and transitions live in tested code, and the agents call one known command
   instead of composing API requests. If the project already has helpers for that tracker (a Jira client, a
   `gh` wrapper, an API library), call them from the script instead of writing new requests. For a local
   tracker such as a SQLite file, inline commands in tracker.md are fine and no script is needed.

   A script needs contract tests, in the project's own test setup, that run each subcommand and check the output
   shape the mod relies on, without a live loop: the JSON fields of `waiting`, `done` and `blockers`, that every
   `id` that `waiting` and `blockers` print, and every `blocked_by`, matches the id rule below,
   `{"merged": true|false}` from `merged`, and `mark-done` succeeding on an already-done ticket and failing on
   a bad id. Stub or record the API responses; the tests must not need to change a real ticket. They must pass
   before tracker.md is saved.

   The three sync commands each print one JSON array (or nothing, meaning none), with exactly these fields:
   - `## List the tickets waiting to be worked` prints `[{"id", "title", "url", "body"}]`, `url` null when there is
     none, `body` the description followed by the acceptance criteria (triage judges the ticket from it). Only work items one PR can finish: filter out epics and other parent or container types in the
     command itself.
   - `## List the tickets that are done` prints `[{"id"}]`, every ticket in a done status.
   - `## List the blockers` prints `[{"id", "blocked_by", "blocker_done"}]`, one row per link from a waiting
     ticket to a ticket it is blocked by or depends on, `blocker_done` true when that ticket is in a done
     status. When the tracker has no such links, the command prints `[]`.

   `id` and `blocked_by` are the tracker's ids, as strings or integers. Each must be one path segment, because the
   pipeline names every agent's worktree `<id>-<role>`: it matches `^[A-Za-z0-9_.@+-]+$` and is neither `.` nor
   `..`. So `42` or `APS-756`, never `owner/repo#42` or a URL: print the tracker's short id, not a reference to it.
   The rule is `TICKET` and `bad()` in `pipeline-agents/src/guards.ts`; if those change, change it here too.

   Each loop pass, before syncing, the mod runs two more for every ticket whose PR is open, so a merged blocker
   releases its dependents in the same pass. Each gets one value as `$1`, passed as an argument and never
   spliced into the command: always quote it as `"$1"`, and never paste it into a query string unchecked.
   - `## Check whether a PR is merged` gets the PR URL as `$1` and prints `{"merged": true}` or
     `{"merged": false}`; anything else stops the pass from syncing. On GitHub:
     `gh pr view "$1" --json state --jq '{merged: (.state == "MERGED")}'`. Use the PR host's CLI or API.
   - `## Mark a ticket done` gets the tracker ticket id as `$1` and moves it to the done status, exiting
     non-zero on failure. It must succeed when the ticket is already done (some trackers close on merge).

   Run each command and check its output before saving. Pipe the output of `waiting` through
   `jq -s -e 'def ok: (type == "string" or type == "number") and (tostring | test("^[A-Za-z0-9_.@+-]+$") and . != "." and . != ".."); .[0] | length > 0 and all(.[]; .id | ok)'`
   while at least one ticket is waiting, and, if the tracker has links, the output of `blockers` through
   `jq -s -e 'def ok: (type == "string" or type == "number") and (tostring | test("^[A-Za-z0-9_.@+-]+$") and . != "." and . != ".."); .[0] | length > 0 and all(.[]; (.id | ok) and (.blocked_by | ok))'`
   while one link exists. Each exits non-zero when an id or `blocked_by` is missing, null or breaks the rule, and
   on empty output, which proves nothing: fix the command and do not save tracker.md until both pass. Check the
   merge command on one merged and one open PR, and mark-done only with the user's go-ahead, on a ticket they
   name. Then add exact, copy-pasteable commands or tool calls, which the agents follow, for:
   - reading one ticket in full (description, acceptance criteria, comments),
   - moving a ticket's status,
   - adding a comment to a ticket,
   - linking a PR to a ticket,
   - and the status mapping from step 2.

   Credentials never go in tracker.md or the script: name the env var or the tool's own login instead.
4. **Copy the defaults** `readiness.md`, `rubric.md` and `routing.md` from this skill's `defaults/` folder into
   `.claude/pipeline/`, skipping any that already exist. Show them to the user and offer to adjust them.
5. Add `.claude/pipeline/pipeline.db` to the project's `.gitignore`.

A new tracker means running this skill again; it overwrites tracker.md only.
