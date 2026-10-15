# Open questions

Things SPEC.md does not settle. Everything else the build decided is described in SPEC.md. Each needs Daniel's call.

1. **Routing is applied by Haiku at triage**, from routing.md, in the same call. That avoids a markdown-table
   parser and lets "security-critical goes to fable" be a judgement. Want a deterministic parser instead?
2. **No `/triage` or `/work` skills.** The loop already does both, so they are not built. Want them as manual
   triggers?
3. **/learn edits the implementer prompts inside the plugin** (`agents/implementer-<model>.md`). If the plugin is
   installed from a marketplace, an update overwrites those edits. Should project-level overrides live in
   `.claude/pipeline/` instead?
4. **report_result is not deferred**, so its schema sits in every session's tool list, the main thread's included,
   where a call is refused. Deferred, an implementer would have to find it through ToolSearch first. Keep it?
5. **"Has reported" is read from the ticket**, not tracked per agent: the SubagentStop hook blocks while the ticket
   is still `in_progress`. A report that was refused (missing field) leaves it `in_progress`, so the agent is told
   to call the tool again. Track calls per agent instead?
6. **Decided: every agent is spawned by the loop's pass.** `report_result` only records and leaves a new stage
   `started = 0`; the pass spawns its agents and sets `started = 1`. The hook cannot spawn them: they would be nested
   in `pipeline-agents` and skip its hooks (`docs/adr/0001`). The cost is up to one pass interval (5 minutes) between
   a report and the next stage's agents.
7. **Tickets started before stages are not reviewed.** A null stage is read as `implement`, but an implementer with
   a null stage was not told to open a draft, so its PR goes straight to `pr_open` whatever its difficulty.
8. **A routing.md without `Review threshold:` reviews from 3**, so no re-setup is needed after a pull. A malformed
   value fails the pass instead. There is no "off": a threshold above 5 never reviews.
9. **Reviewers are read-only by prompt plus `disallowedTools: Write, Edit, NotebookEdit`**; they still have Bash,
   which they need for `gh` and the tracker commands.
10. **The pipeline.db guard is a text match on Bash commands.** Any Bash command of a pipeline agent that contains
    `pipeline.db` is refused, reads included, and so is a commit message or PR body that names it. Read, Grep and
    other tools are not checked, and a command that builds the path (`pipeline.d"b"`) gets through. It stops the
    habit; it is not a boundary. Narrow it to `sqlite3` writes, or widen it to every tool?
11. **Decided: several sessions may run the loop on one project, so tickets carry an owner and a heartbeat** —
    a lease, which the first version left out. `$.agent.list()` only sees its own session's agents, so without an
    owner a second session sent the first's `in_progress` tickets to needs_human as orphans, and two passes close
    together could both spawn an implementer for one ticket. The claim (`ready` → `in_progress`) is one guarded
    update that also requires nothing to be `in_progress`; only the pass that gets the row back spawns. A session
    stopped for 15 minutes (3 passes) loses its tickets to needs_human, so a slow pass or a laptop asleep for that
    long does too. The owner is the session id read once at session start.
12. **Agent limits soft-stop reviewers with the same text as everyone else**: "call report_result now", though a
    reviewer does not report and its `report_result` call is refused. Every other call is refused too, so a reviewer
    at its limit cannot post its comment. When it stops, even inside its two requests of grace, its ticket goes to
    needs_human as if hard-stopped, so a missing review is never passed to the verifier. Tell reviewers to post what
    they have instead? The limits fail open: an error in either hook (a sqlite failure, a typo such as
    `Agent time limit: 2h` in routing.md) is logged in the pipeline log and the request or call runs unlimited. One pair of limits serves every model and role until ticket 22's
    usage shows how to tune them. A request with no `usage` leaves the context of the last one that had it.
13. **The worktree guard stops accidents, not deliberate evasion.** It checks `Edit`, `Write`, `NotebookEdit` and
    the first bare `git` word of each simple command in a Bash command line, wherever it sits (so `rtk proxy git`,
    `timeout 30 git`, `sudo git` and `sh -c 'git …'` are checked, and a word `git` that is not the command, as in
    `grep git src`, is refused as unplaceable). General shell writes in the main checkout (`sed -i`, `>`, `mv`,
    `rm`, `cp`, scripts) are not detected, nor is git run from a Makefile, an npm script or a file the agent wrote.
    Paths are compared as text, so a symlink into the main checkout gets through, as does a path that differs only
    in case on a case-insensitive filesystem (macOS by default: `/Users/x/Code/app` for `/Users/x/code/app`), and a
    subshell's `cd` is taken to persist. Only the main checkout is protected: a worktree of another ticket or any
    other folder on disk is not.
