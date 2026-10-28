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
   `blockers`, `merged`, `mark-done` (and `restack` with stacked PRs, step 5), plus `read`, `move`, `comment` and `link-pr` for the agents. Each section
   of tracker.md is then one line calling the script, for example `.claude/pipeline/tracker.sh merged "$1"`.
   Auth, pagination, JSON shaping and transitions live in tested code, and the agents call one known command
   instead of composing API requests. If the project already has helpers for that tracker (a Jira client, a
   `gh` wrapper, an API library), call them from the script instead of writing new requests. For a local
   tracker such as a SQLite file, inline commands in tracker.md are fine and no script is needed.

   A script needs contract tests, in the project's own test setup, that run each subcommand and check the output
   shape the mod relies on, without a live loop: the JSON fields of `waiting`, `done` and `blockers`, that every
   `id` that `waiting` and `blockers` print, and every `blocked_by`, matches the id rule below,
   `{"merged": true|false}` or `{"merged": false, "closed": true}` from `merged`, and `mark-done` succeeding on an already-done ticket and failing on
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
   - `## Check whether a PR is merged` gets the PR URL as `$1` and prints `{"merged": true}`, `{"merged": false}`
     while it is open, or `{"merged": false, "closed": true}` when it was closed without merging, which sends its
     ticket to you; anything else stops the pass from syncing. On GitHub:
     `gh pr view "$1" --json state --jq 'if .state == "CLOSED" then {merged: false, closed: true} else {merged: (.state == "MERGED")} end'`.
     Use the PR host's CLI or API. A command that never prints `closed` still works: a closed PR then reads as open.
   - `## Mark a ticket done` gets the tracker ticket id as `$1` and moves it to the done status, exiting
     non-zero on failure. It must succeed when the ticket is already done (some trackers close on merge).

   Run each command and check its output before saving. Pipe the output of `waiting` through
   `jq -s -e 'def ok: (type == "string" or type == "number") and (tostring | test("^[A-Za-z0-9_.@+-]+$") and . != "." and . != ".."); .[0] | length > 0 and all(.[]; .id | ok)'`
   while at least one ticket is waiting, and, if the tracker has links, the output of `blockers` through
   `jq -s -e 'def ok: (type == "string" or type == "number") and (tostring | test("^[A-Za-z0-9_.@+-]+$") and . != "." and . != ".."); .[0] | length > 0 and all(.[]; (.id | ok) and (.blocked_by | ok))'`
   while one link exists. Each exits non-zero when an id or `blocked_by` is missing, null or breaks the rule, and
   on empty output, which proves nothing: fix the command and do not save tracker.md until both pass. Check the
   merge command on one merged and one open PR, and one closed without merging if there is one, and mark-done only with the user's go-ahead, on a ticket they
   name. Then add exact, copy-pasteable commands or tool calls, which the agents follow, for:
   - reading one ticket in full (description, acceptance criteria, comments),
   - moving a ticket's status,
   - adding a comment to a ticket,
   - linking a PR to a ticket,
   - and the status mapping from step 2.

   Credentials never go in tracker.md or the script: name the env var or the tool's own login instead.
4. **Copy the defaults** `readiness.md`, `rubric.md` and `routing.md` from this skill's `defaults/` folder into
   `.claude/pipeline/`, skipping any that already exist. Show them to the user and offer to adjust them.
5. **Stacked PRs (optional).** By default a ticket blocked by another waits until its blocker's PR merges. Ask
   whether the PR host supports stacked PRs (a PR whose base is another PR's branch, retargeted when that one
   merges) and whether the user wants them. If not, leave routing.md's `Stack depth: 1` and skip this step. If yes,
   add two sections to tracker.md; a `Stack depth:` above 1 without both stops every pass from syncing, with
   "run /tracker-setup":
   - `## Open a stacked PR`: instructions the implementer follows, like the read and link-pr ones, not run by the
     mod: how to find a PR's head branch, and how to open a PR stacked on a given PR (its base that PR's head
     branch), as a draft or not as its prompt says.
   - `## Bring a stacked PR up to date`: a command the mod runs each pass for every stacked ticket whose PR is open,
     bottom of the stack first, with the PR URL as `$1` like the merge check. It brings the PR's branch up to date
     with its base on the host, succeeds when it is already up to date, and exits non-zero, with the reason on
     stderr, on a conflict or any other failure: the ticket then comes to you. It must not touch any local checkout
     (the mod runs it in the user's main checkout), so it is a server-side update, and it never force-pushes.

   On GitHub, native stacks use the `github/gh-stack` gh extension
   (https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands). Check it with
   `gh extension list`; install it (`gh extension install github/gh-stack`) only with the user's go-ahead. Then:
   - Open a stacked PR: the head branch is `gh pr view <blocker PR> --json headRefName --jq .headRefName`. Push
     the branch, open the PR on that branch with `gh pr create --base <head branch>` (`--draft` when the prompt
     says draft), then join it to the blocker's stack with `gh stack link <blocker PR URL> <new PR URL>`, which
     makes the stack when there is none, extends the blocker's stack otherwise, and fixes a base that does not
     match. `gh stack link` has no `--auto`, and its `--open` marks every PR in the stack ready for review, so
     leave it out: the draft rule is the `gh pr create` flag.
   - Bring a stacked PR up to date, as a `restack` subcommand of the script (`gh pr update-branch` merges the base
     in and fails when there is nothing to merge, so it only runs when the PR is behind):

     ```sh
     state=$(gh pr view "$1" --json mergeStateStatus --jq .mergeStateStatus) || exit 1
     case "$state" in
       BEHIND) gh pr update-branch "$1" ;;
       DIRTY) echo "$1 conflicts with its base" >&2; exit 1 ;;
     esac
     ```

   Add contract tests for it to the script's tests: it succeeds on a PR already up to date and fails on a bad PR
   URL. Then set routing.md's `Stack depth:` to the most unmerged PRs a stack may hold, counting its bottom one
   (2 lets one ticket build on one open PR).
6. Add `.claude/pipeline/pipeline.db` to the project's `.gitignore`.

A new tracker means running this skill again; it overwrites tracker.md only.
