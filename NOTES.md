# Open questions

Things SPEC.md does not settle. Built without them; each needs Daniel's call.

1. **Triage sees only the title and URL.** The table has no column for the ticket's description, and
   `$.model.complete` has no tools to fetch it, so Haiku judges readiness from the title alone and will mark
   most tickets needs_human. Cheapest fix: a `body` column that sync fills. Add it?
2. **Routing is applied by Haiku at triage**, from routing.md, in the same call. That avoids a markdown-table
   parser and lets "security-critical goes to fable" be a judgement. It only routes to sonnet, opus or fable,
   the models with an implementer agent; the table's `haiku` value is never used. Want a deterministic parser?
3. **The implementer works in its own git worktree.** SPEC.md rules out worktree management, but an implementer
   switching branches in the checkout you are reviewing in would lose your work. It is one line in the agent
   prompt (create, then remove), no mod code. Keep it?
4. **Defaults for readiness.md, rubric.md and routing.md** ship in `skills/tracker-setup/defaults/` and
   /tracker-setup copies them into `.claude/pipeline/` when absent. SPEC.md does not say who writes them.
5. **The loop's agents' completion notices are dropped** (`prompt.submit`, origin `task-notification`, an agent
   described `pipeline …`). Without it every sync and implementer that finishes starts a main-thread turn, which
   SPEC.md says the loop must never do. You still see a one-line notice. Sync runs every pass, so that is one
   line every 5 minutes. Fine, or sync less often?
6. **An in_progress ticket with no live implementer goes to needs_human.** Otherwise a crashed or killed
   implementer (or a session restart) leaves it in_progress and the loop never spawns again.
7. **Background agents and permissions.** Under auto mode the first timer-driven spawn in the probe was denied
   ("gave no verdict": no user request behind it); the loop logs the deny and retries next pass. In other modes
   the implementer's `git push` / `gh pr create` may raise permission prompts in your session. SPEC.md assumes
   neither. Which permission setup should the loop expect?
8. **No `/triage` or `/work` skills.** SPEC.md lists them, but the build brief's skill list does not, and the loop
   already does both. Left out. Want them as manual triggers?
9. **/pipeline-status saves your answer as a tracker comment**, so tracker.md also describes how to comment
   (SPEC.md names list, read, move and link). The table has no column for the answer; see 1.
10. **/learn edits the implementer prompts inside the plugin** (`agents/implementer-<model>.md`). If the plugin is
    installed from a marketplace, an update overwrites those edits. Should project-level overrides live in
    `.claude/pipeline/` instead?
