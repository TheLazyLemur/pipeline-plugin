---
name: learn
description: Learn from review comments on the pipeline's PRs. Works through each unprocessed PR's comments with the user and changes the file that would have prevented each problem. Use when the user runs /learn or asks to learn from PR reviews.
---

# Learn

The database is `.claude/pipeline/pipeline.db`, table `tickets`, read and written with the `sqlite3` CLI.

1. Find the PRs not yet learned from:
   `select ticket_id, title, model, pr_url from tickets where pr_url is not null and learned = 0`
2. For each PR, read its review comments and review threads (for GitHub:
   `gh pr view <url> --comments` and `gh api repos/<owner>/<repo>/pulls/<n>/comments`). Skip PRs with no review
   comments yet unless the PR is merged or closed.
3. With the user, go through what the reviewers raised. For each real problem, agree what went wrong and which
   file should change so it does not happen again:
   - the project's `CLAUDE.md` or its rules,
   - the implementer prompt for that model (`agents/implementer-<model>.md` in the pipeline plugin), or the
     review agents' (`agents/reviewer-spec.md`, `reviewer-quality.md`, `verifier.md`, `fixer.md`) if agent review
     should have caught it,
   - `.claude/pipeline/readiness.md` if the ticket should not have been ready,
   - `.claude/pipeline/rubric.md` or `routing.md` if it went to the wrong model or skipped agent review
     (routing.md's `Review threshold`),
   - or a checklist the project keeps.
4. Show each proposed change as a diff. Apply it only when the user approves it.
5. When a PR is done: `update tickets set learned = 1 where ticket_id = '<id>'`
