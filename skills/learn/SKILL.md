---
name: learn
description: Learn from the review of the pipeline's PRs, both human review comments and agent review (the verifier's checked findings and the fixer's notes). Works through each unprocessed PR with the user and changes the file that would have prevented each problem. Use when the user runs /learn or asks to learn from PR reviews.
---

# Learn

The database is `.claude/pipeline/pipeline.db`, table `tickets`, read and written with the `sqlite3` CLI.

1. Find the PRs not yet learned from:
   `select ticket_id, title, model, pr_url from tickets where pr_url is not null and learned = 0`
2. For each PR, read its comments, general and inline together, with the project's `tracker` tool
   (`mcp__pipeline-tracker__tracker`, `op: "pr_comments"` with `url`), and its title and whether it merged or closed
   with `op: "pr_view"`. Sort the comments into:
   - **agent findings**: the latest comment whose first line is `Checked review findings`, posted by the verifier.
     Its numbered list is the findings that survived checking. `Checked review findings: none` means none did.
   - **fixer notes**: the latest comment whose first line is `Fixer notes`, posted by the fixer. Each line
     `<n>. fixed: ...` or `<n>. not fixed: <reason>` is the outcome of finding `<n>` in the checked list.
   - **human comments**: every other review comment and thread.

   Skip a PR whose title still starts with `Draft: ` and has no agent findings comment, unless it is merged or
   closed: agent review has not finished. A draft PR with a `Checked review findings` comment is processed (the
   fixer blocked or never ran, and agent review has produced its record).
   Skip a PR with no agent findings and no human comments unless it is merged or closed. A PR with agent findings
   and no human comments is processed.
3. Classify what each PR raised:
   - a finding the fixer **fixed** is a confirmed implementer mistake: learn from it.
   - a finding the fixer **did not fix** is a judgement call. Show it to the user with the fixer's reason and ask
     whether the finding or the fixer was right; learn from it only if the user says the implementer was wrong.
   - a finding with no fixer note (the fixer blocked or never ran) is shown to the user like a judgement call.
   - a human comment that raises a real problem is a confirmed mistake. One the agents missed also points at the
     review agents.
4. Before proposing changes, group the confirmed mistakes of every PR this run processes by kind (for example
   "missing test for the error path", "ignored an acceptance criterion", "edited the main checkout"). A kind seen on
   more than one PR is a pattern: it points at a standing instruction, so propose a change for it once, citing every
   PR it came from. A one-off may need nothing; say so and let the user decide.
5. With the user, for each pattern and each one-off the user wants to act on, agree what went wrong and which file
   should change so it does not happen again:
   - the project's `CLAUDE.md` or its rules,
   - the implementer prompt for that model (`agents/implementer-<model>.md` in the pipeline plugin), or the
     review agents' (`agents/reviewer-spec.md`, `reviewer-quality.md`, `verifier.md`, `fixer.md`) if agent review
     should have caught it,
   - `.claude/pipeline/readiness.md` if the ticket should not have been ready,
   - `.claude/pipeline/rubric.md` or `routing.md` if it went to the wrong model, or a too-high `Review size` in
     routing.md if a large PR skipped agent review,
   - or a checklist the project keeps.
6. Show each proposed change as a diff. Apply it only when the user approves it.
7. Once every proposal of the run has been approved or declined, mark each PR this run processed as learned:
   `update tickets set learned = 1 where ticket_id = '<id>'`. Not before: a PR's mistakes count towards step 4's
   grouping until the run ends. A PR skipped in step 2 stays at `learned = 0`.
