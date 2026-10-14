# Open questions

Things SPEC.md does not settle. Built without them; each needs Daniel's call.

1. **Triage sees only the title and URL.** The table has no column for the ticket's description, and
   `$.model.complete` has no tools to fetch it, so Haiku judges readiness from the title alone and will mark
   most tickets needs_human. Cheapest fix: a `body` column that sync fills. Add it?
