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
