# Open questions

Things SPEC.md does not settle. Everything else the build decided is described in SPEC.md. Each needs Daniel's call.

1. **Routing is applied by Haiku at triage**, from routing.md, in the same call. That avoids a markdown-table
   parser and lets "security-critical goes to fable" be a judgement. Want a deterministic parser instead?
2. **No `/triage` or `/work` skills.** The loop already does both, so they are not built. Want them as manual
   triggers?
3. **/learn edits the implementer prompts inside the plugin** (`agents/implementer-<model>.md`). If the plugin is
   installed from a marketplace, an update overwrites those edits. Should project-level overrides live in
   `.claude/pipeline/` instead?
