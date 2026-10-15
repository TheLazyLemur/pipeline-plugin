# Agent review of draft PRs

## Problem Statement

The only check on an implementer's work before the user reviews it is the implementer running the tests it
wrote, graded by the same agent that wrote the code. Problems that a second pair of eyes would catch (the
ticket's spec not met, prompt rules ignored, poor code quality) reach the user's review, where they cost the
user's time. Ticket 6's implementer, for example, ignored two prompt rules and nothing caught it before the
PR.

## Solution

Tickets of difficulty 3 and above open as draft PRs (a `Draft: ` title prefix). Two reviewers, a spec
reviewer and a quality reviewer, review the draft in parallel on a model one tier above the implementer and
post their findings on the ticket. A verifier on the same tier checks each finding against the code, drops
false ones, merges duplicates and posts the checked list on the ticket and the PR. If findings remain, a
separate fixer on the implementer's model addresses them on the same PR. One round only: after the verifier
(no findings) or the fixer, the draft prefix is removed and the PR is the user's to review, with the findings
and the fixer's notes attached. Difficulty 1 and 2 tickets skip review and open as normal PRs. The flow works
in running sessions after a hot reload, with no re-setup.

## User Stories

1. As a user, I want difficulty 3+ PRs reviewed by agents before I see them, so that obvious problems are fixed before my review.
2. As a user, I want difficulty 1–2 PRs to skip agent review, so that trivial changes do not cost reviewer tokens.
3. As a user, I want the review threshold in routing.md, so that /learn can tune it with the rest of routing.
4. As a user, I want reviewers on a model one tier above the implementer, so that they are not just repeating its blind spots.
5. As a user, I want reviewers to see only the ticket, the spec and the diff, not the implementer's reasoning, so that their review is independent.
6. As a user, I want a spec review and a quality review, so that both "does it do what the ticket says" and "is it well made" are checked.
7. As a user, I want a verifier to drop false findings and merge duplicates, so that the fixer does not act on reviewer mistakes and I do not read noise.
8. As a user, I want the checked findings on the PR, so that I see them where I review and /learn can read them.
9. As a user, I want the checked findings on the ticket, so that the fixer reads them there.
10. As a user, I want the fixer to be a separate agent from the implementer, so that fixing review findings is its own job with its own prompt.
11. As a user, I want the fixer to push to the existing branch and PR, so that I review one PR per ticket.
12. As a user, I want the fixer to note on the PR what it fixed and why it did not fix the rest, so that I can judge its choices.
13. As a user, I want only one review round, so that agent review never loops.
14. As a user, I want a PR with no verified findings to go straight to me without a fixer, so that clean work is not delayed.
15. As a user, I want a blocked fixer to send the ticket to needs_human with its question and leave the PR a draft, so that I know it needs me.
16. As a user, I want the draft prefix removed when agent review is finished, so that the title tells me when a PR is mine to review.
17. As a user on GitLab, I want the `Draft: ` prefix, so that my host treats the merge request as a real draft.
18. As a user, I want the next ticket to wait until review and fix are done, so that only one worktree is ever in use.
19. As a user with a running session, I want this to start working after I pull, so that I do not have to restart or re-run /tracker-setup.
20. As a user, I want a reload or restart in the middle of a review to carry on at the next pass, so that no ticket gets stuck mid-review.
21. As a user, I want tickets already in flight when this lands to finish without review, so that nothing breaks during the change-over.
22. As a user, I want /pipeline-status to show a ticket's stage beside in_progress, so that I can see whether it is being implemented, reviewed, verified or fixed.

## Implementation Decisions

- **Review threshold:** routing.md gains the difficulty at and above which a ticket is reviewed (default 3). Triage already reads routing.md; the loop reads the threshold from the same file.
- **Draft prefix:** the mod tells the implementer in its prompt whether to open the PR as a draft on the host (`gh pr create --draft`) with the title prefix `Draft: ` (difficulty at or above the threshold), or as a normal PR without it.
- **New `stage` column** on tickets: `implement`, `review`, `verify` or `fix`; status stays `in_progress` throughout. `migrate()` adds it when missing, so a running session gains it on the next pass after a pull. A null stage reads as `implement`.
- **Stage transitions**, driven each pass from `stage` plus the live pipeline agents, and from `report_result` (ticket 8):
  - implementer reports a PR, difficulty at or above the threshold → stage `review`; spawn both reviewers.
  - implementer reports a PR, difficulty below the threshold → `pr_open`, as today.
  - stage `review` and no reviewer for the ticket still live → stage `verify`; spawn the verifier.
  - verifier reports 0 findings → `pr_open`.
  - verifier reports more than 0 findings → stage `fix`; spawn the fixer.
  - fixer reports a PR → `pr_open`.
  - fixer reports blocked → `needs_human` with its question.
- **No state in the mod's memory:** reviewers post findings as ticket comments; the verifier reads them from the ticket. A reload or restart resumes from `stage` at the next pass. A stage whose agent is gone without reporting follows the existing orphan rule.
- **Models:** reviewers and verifier run one tier above the ticket's routed model (sonnet → opus, opus → fable, fable → fable). The fixer runs on the routed model.
- **Agent files, one per role:** `reviewer-spec`, `reviewer-quality`, `verifier`, `fixer`. The model is passed at spawn time.
- **Reviewers** are read-only: they read the ticket, any spec it references, and the PR diff and files at the PR's commit, with no worktree. Each posts its findings as one ticket comment.
- **Verifier** checks each finding against the code, drops false ones, merges duplicates, posts the checked list as a ticket comment and a PR comment, and reports the count through `report_result`. With 0 findings it marks the PR ready on the host (`gh pr ready`) and removes the `Draft: ` prefix from the PR title.
- **Fixer** checks out the PR's existing branch in a worktree, addresses the checked findings, pushes to the same PR, comments on the PR what it fixed and why not for the rest, marks the PR ready on the host, removes the `Draft: ` prefix, and reports through `report_result`.
- **Agent descriptions** follow the existing `pipeline <ticket_id>` tag pattern, with the role distinguishable, so that the notification filter, the permission hook and the live-agent checks cover the new agents.
- **One ticket at a time:** a ticket in any stage counts as in progress, so no new implementer is spawned until it reaches `pr_open` or `needs_human`.
- **No tracker.md changes:** the draft state is the host's draft flag plus a title prefix, which agents set and clear through the host's CLI; no new required section.
- **/pipeline-status** shows the stage beside `in_progress`.

## Testing Decisions

- Test the loop's externally visible behaviour: rows and spawns before and after a pass, not internal calls.
- Seam: the loop's `pass`, through the existing loop tests and their `deps` stub (fake spawns and live agent list). Cases:
  1. A difficulty 3+ ticket whose implementer reported a PR moves to stage `review` and both reviewers are spawned one tier up.
  2. Stage `review` with no live reviewer spawns the verifier (stage `verify`); with a reviewer still live, nothing happens.
  3. A difficulty 1–2 ticket's implementer prompt says to open without the prefix and it goes straight to `pr_open`.
  4. While any stage is in progress, no new implementer is spawned.
  5. A database without `stage` gains it on the first pass; existing rows read as `implement`.
- Seam: ticket 8's `report_result` handler, a pure function. Cases: verifier with 0 findings → `pr_open`; above 0 → stage `fix`; fixer with a PR → `pr_open`; fixer blocked → `needs_human`.
- Prior art: the loop tests' `deps` stub and `freshProject`; ticket 8's handler tests.
- Not code-tested: the agents' behaviour (comments, title edits, pushes). Checked by a live run on one difficulty 3+ ticket.

## Open Questions

- Whether a hot reload registers new plugin agent files in a running session, or only a session start does. The implementer agents appeared on first load without a restart, so it probably does; the live run confirms it.

## Out of Scope

- A second review round.
- A wider fan-out of reviewers (the user does that at PR review).
- A tracker.md command for marking a PR ready: agents use the host's CLI, like the title edit.
- Running review or fix alongside the next ticket's implementer.
- Reviewing tickets already in flight when this lands.

## Further Notes

- Depends on ticket 8 (`report_result` and the SubagentStop guard); the verifier and fixer report through it.
- Review adds roughly four agent runs per reviewed ticket (two reviewers, verifier, fixer), two of them a tier up.
