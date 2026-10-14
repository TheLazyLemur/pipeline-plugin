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
6. **Agent review spawns from two places.** The reviewers and the fixer are spawned by the `report_result` hook,
   while the reporting agent is still live; the verifier by the pass, once no agent of the ticket is live. The
   table has no "spawned" marker, so the pass alone cannot tell a stage whose agent has not started from one whose
   agent is gone. A `review`/`fix` stage whose spawn throws (not denied) is logged only: at `review` the pass then
   starts the verifier with no reviews. Add a marker instead?
7. **Tickets started before stages are not reviewed.** A null stage is read as `implement`, but an implementer with
   a null stage was not told to open a draft, so its PR goes straight to `pr_open` whatever its difficulty.
8. **A routing.md without `Review threshold:` reviews from 3**, so no re-setup is needed after a pull. A malformed
   value fails the pass instead. There is no "off": a threshold above 5 never reviews.
9. **Reviewers are read-only by prompt plus `disallowedTools: Write, Edit, NotebookEdit`**; they still have Bash,
   which they need for `gh` and the tracker commands.
