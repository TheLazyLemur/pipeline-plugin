# Stacked PRs

## Problem Statement

A ticket blocked by another is held until its blocker is done, so a chain of dependent tickets is built one merge at
a time: each waits for a human to review and merge the PR before it. The loop sits idle while the human is the
bottleneck, even when the blocker's PR is finished and only waiting for review. Some PR hosts support stacked PRs
(a PR whose base is another PR's branch, retargeted when that one merges), which let the dependent start on the
blocker's unmerged code without the rework at merge that `docs/specs/dependency-flow.md` set out to avoid.

## Solution

Opt-in stacking. A project that turns it on lets a dependent start once its blocker's PR is open and handed to the
human (`pr_open`): the implementer branches from the blocker's branch and opens its PR stacked on the blocker's PR.
Each pass brings every open stacked PR up to date with the PR under it, bottom first, and a PR closed without
merging sends its ticket and every ticket stacked on it to the human. Stacks are linear and capped in depth. The
plugin stays provider-agnostic: how to open a stacked PR and how to bring one up to date are tracker.md sections;
the plugin only checks they exist.

## User Stories

1. As a user, I want a dependent ticket to start once its blocker's PR is ready for my review, so that the loop keeps working while I review.
2. As a user, I want stacking off unless I turn it on, so that a project without stacked PR support behaves as before.
3. As a user, I want to cap how many unmerged PRs a stack holds, so that I am not handed a tall stack to review at once.
4. As a user, I want a dependent held while its blocker is still under agent review or was built outside the pipeline, so that it never stacks on a PR that may still change shape or has no row.
5. As a user, I want a ticket with two unfinished blockers held, so that a PR never needs two bases.
6. As a user, I want one dependent per blocker stacked at a time, so that stacks stay linear.
7. As a reviewer, I want a stacked PR to show only its own change, so that I review the dependent without the blocker's diff.
8. As a user, I want each open stacked PR brought up to date with the PR under it every pass, so that review fixes on the blocker reach its dependents.
9. As a user, I want a stacked PR that conflicts with the PR under it sent to me with the error, so that I resolve it.
10. As a user, I want a PR closed without merging to send its ticket and every ticket stacked on it to me, so that no work builds on a dead branch.
11. As a user, I want a stacked ticket freed once its blocker is done, so that its PR is an ordinary PR from then on.
12. As a user, I want `/tracker-setup` to ask whether my host supports stacked PRs and write both sections, so that turning it on is one conversation.
13. As a user with stacking turned on and a tracker.md without the sections, I want every pass to fail loudly with "run /tracker-setup", so that stacking never half-works.
14. As a user with a tracker.md from before this change, I want my merge check to keep working, so that I need no re-setup.
15. As a user, I want `/pipeline-status` to show what each ticket is stacked on, and not list a stacked ticket as held, so that I see the stacks.

## Implementation Decisions

- **Two switches, both required.** Capability: two optional tracker.md sections. Policy: routing.md's `Stack depth: <n>`, read with `whole()`, default 1: the most unmerged PRs a stack may hold, counting its bottom one. 1 is off. Depth above 1 with either section missing fails the done and sync steps with "tracker unreachable: tracker.md has no … under "## …"; run /tracker-setup".
- **`## Open a stacked PR`:** instructions the implementer follows (find a PR's head branch, open a PR stacked on a given PR). Not run by the mod; only its presence is checked.
- **`## Bring a stacked PR up to date`:** a command, first fenced block, PR URL as `$1` (`sh -c '<cmd>' sh <url>`). Brings the PR's branch up to date with its base on the host, exit 0 when already up to date, non-zero on a conflict or any failure. Server-side only: the mod runs it in the human's main checkout.
- **Release rule (sync).** With depth above 1, a waiting ticket whose not-done blockers are exactly one ticket B is inserted with `stacked_on = B` when B's row is `pr_open` with a `pr_url`, B's chain height plus one is at most the depth (height of B = 1 + height of B.stacked_on when that is set and not done, else 1), and no other not-done ticket has `stacked_on = B`. Otherwise it is held as before. `stacked_on` is recomputed every pass for new and ready rows and never changed on a started row, except cleared.
- **Store.** Nullable `stacked_on text` on `tickets`, added through `ADDED` in `migrate()`; no backfill. When a ticket becomes done (merged PR, or the tracker's done list), every ticket stacked on it has `stacked_on` cleared: the host retargets its PR.
- **Implementer.** A claimed ticket with `stacked_on` gets `Stack on: <blocker pr_url>` in its spawn prompt. The implementer finds that PR's head branch following `## Open a stacked PR`, cuts its branch from it, diffs against it for the writing-pull-requests skill (`probe --base`), and opens the PR following that section, keeping the draft rule. The fixer diffs against the PR's own base. Reviewers and the verifier already read `gh pr diff`, which is against the PR's base.
- **Restack (each pass).** After the merge check and before sync, for each `pr_open` ticket with `stacked_on`, bottom of its stack first, run the up-to-date command with its `pr_url`. Only `pr_open`: an `in_progress` one has an agent on its branch. A failure sends the ticket to needs_human with a question naming the PR it is stacked on and the command's stderr.
- **Closed PR.** The merge check may print `{"merged": false, "closed": true}`. `{"merged": true}` and `{"merged": false}` stay valid; any other shape, `{"merged": true, "closed": true}` included, is an error. A closed PR sends its ticket to needs_human, and every not-done ticket stacked on it that is not already there, with a question naming the dead PR. This applies with stacking off too.
- **GitHub.** `/tracker-setup` suggests the `github/gh-stack` extension: `gh pr create --base <blocker head branch>` (with `--draft` for a draft), then `gh stack link <blocker PR> <new PR>`; and an up-to-date script that runs `gh pr update-branch` only when `mergeStateStatus` is `BEHIND`, and fails on `DIRTY`.
- **Guards.** The worktree guard inspects the word `git` only; `gh stack link`, `gh pr create --base` and `git worktree add … origin/<branch>` from the agent's worktree are not refused. Nothing changed.

## Testing Decisions

- Through the public seam: `sync` in `test/sync.spec.ts`, and the loop's `pass` in `test/loop.spec.ts` with `freshProject` and the SQLite tracker fixture, which gains the two sections, a closed-PR list and a recorded up-to-date command.
- Cases: released with `stacked_on` when the only unfinished blocker is `pr_open`; held when the blocker is in progress, with two unfinished blockers, at the depth cap, and when the blocker already has a stacked ticket; depth 1 is the existing tests unchanged; depth above 1 without either section fails the pass; the implementer prompt carries `Stack on:`; done clears `stacked_on` by merge and by the tracker's done list; restack runs for `pr_open` stacked tickets only, bottom first, with the URL as literal `$1`; a restack failure goes to needs_human with stderr; a closed PR sends it and its stacked ticket to needs_human; `{"merged": true, "closed": true}` is refused.
- Not code-tested: the agent prompts, `/tracker-setup` and `/pipeline-status`, which are skill text and are checked by a live run.

## Open Questions

- Does GitHub report `mergeStateStatus: BEHIND` for a PR whose base is an unprotected feature branch? If it reports `CLEAN` instead, the suggested up-to-date script never updates a stacked PR (NOTES.md).

## Out of Scope

- Branching trees of stacks (two dependents on one blocker).
- A dependent with more than one unfinished blocker.
- Stacking on a blocker still in agent review, or on a PR the pipeline did not open.
- Rebasing or force-pushing stacked branches; the up-to-date command merges.
- Bringing an `in_progress` stacked ticket's branch up to date while its agent works.
- Moving a started ticket to a different base.

## Further Notes

- The loop still runs one ticket at a time; a stacked ticket only removes the wait for the blocker's merge.
- When a blocker merges, the host retargets the dependent's PR (gh-stack does this for native stacks); the pipeline only clears `stacked_on`.
