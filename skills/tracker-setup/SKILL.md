---
name: tracker-setup
description: Connect the pipeline to this project's ticket tracker. Finds the tracker tooling, reads the board's statuses and writes .claude/pipeline/tracker.md. Use when setting up the pipeline in a project or switching tracker.
---

# Tracker setup

A conversation with the user. The result is `.claude/pipeline/tracker.md`, which the pipeline's agents follow to
talk to the tracker. No adapter code: the file is instructions.

1. **Find the tracker.** Ask which tracker and board or project this repo uses if it is not obvious. Look for what
   can reach it: a connected MCP server, `gh` (run `gh auth status`), `acli` or a Jira API token in an env var, or
   anything else the user names. Try a read-only call to prove it works.
2. **Read the board's statuses** and agree with the user on the mapping:
   - which tracker statuses mean a ticket is waiting to be worked (sync pulls these in as `new`),
   - which status to move a ticket to when the implementer starts, when its PR is open, and which mean done.
3. **Write `.claude/pipeline/tracker.md`** with exact, copy-pasteable commands or tool calls for:
   - listing the tickets waiting to be worked, with id, title and URL. Only work items one PR can finish:
     filter out epics and other parent or container types in the command itself,
   - listing one ticket's blockers (the tickets it is blocked by or depends on) with each one's status. If the
     tracker has no such links, say so,
   - reading one ticket in full (description, acceptance criteria, comments),
   - moving a ticket's status,
   - adding a comment to a ticket,
   - linking a PR to a ticket,
   - and the status mapping from step 2.

   Credentials never go in the file: name the env var or the tool's own login instead.
4. **Copy the defaults** `readiness.md`, `rubric.md` and `routing.md` from this skill's `defaults/` folder into
   `.claude/pipeline/`, skipping any that already exist. Show them to the user and offer to adjust them.
5. Add `.claude/pipeline/pipeline.db` to the project's `.gitignore`.

A new tracker means running this skill again; it overwrites tracker.md only.
