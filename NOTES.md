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
