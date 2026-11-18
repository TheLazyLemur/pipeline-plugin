# Review by surface

## Problem Statement

Whether a PR gets agent review is decided by the ticket's triage difficulty (`Review threshold: 3` in `routing.md`),
before any code exists. Difficulty measures how hard the work is, not what a mistake would break: a difficulty 2
sonnet ticket that touches auth or a schema is never reviewed, while a difficulty 4 mechanical refactor always is.
Because difficulty also picks the model, review in practice follows the model rather than the change.

## Solution

Review is decided from the change itself, once the implementer has opened its PR. Every implementer opens a draft.
When it reports, the loop reads the PR's diff: a change at or above a size limit is reviewed; a smaller one is
reviewed when Haiku finds it crosses a surface (more than one module or service, a schema or migration, a published
contract, a trust boundary). A change that needs no review is marked ready with `pr_ready` and goes straight to the
user. Difficulty keeps one job: picking the implementer's model.

## User Stories

1. As a user, I want review decided from the actual diff, so that the decision reflects what changed rather than a guess made before the work.
2. As a user, I want a small change that touches auth, permissions, secrets, payments or crypto reviewed, so that trust-boundary changes never skip review.
3. As a user, I want a small change that alters a schema or adds a migration reviewed, so that data changes get a second look.
4. As a user, I want a small change that alters a published contract (API, event, config key, tool) reviewed, so that callers are not broken unseen.
5. As a user, I want a small change spanning more than one module, service or datastore reviewed, so that cross-cutting changes get a second look.
6. As a user, I want any change at or above a size limit reviewed without asking Haiku, so that large changes are always reviewed.
7. As a user, I want the size limit in `routing.md`, so that I can tune it per project.
8. As a user, I want a sensible default size limit when `routing.md` does not set it, so that existing projects work with no re-setup.
9. As a user, I want small, single-surface changes to skip review, so that tokens go where review pays.
10. As a user, I want the loop, not the implementer, to decide, so that the author never grades its own work.
11. As a user, I want every implementer to open a draft, so that nothing reaches me before the decision.
12. As a user, I want a PR that needs no review marked ready and moved to `pr_open` by the loop, so that it reaches me at once.
13. As a user, I want a log line saying why a PR was or was not reviewed, so that I can check the decision.
14. As a user, I want a failed decision (tracker unreachable, no Haiku answer) retried on the next pass, so that a blip neither skips review nor stalls the ticket for good.
15. As a user, I want difficulty to keep picking the implementer's model, so that routing does not change.
16. As a user, I want the reviewers, verifier and fixer to work as today once review is chosen, so that only the decision moves.

## Implementation Decisions

- **Every implementer opens a draft:** the spawn prompt always says `pr_create` with `draft: true`.
- **`report_result`:** an implementer's `pr_open` at stage `implement` always moves the ticket to stage `review` with `started = 0`. Difficulty no longer matters there. A ticket with no stage (from before review existed) still goes straight to `pr_open`.
- **The decision, in the loop's pass,** for a ticket at stage `review` with `started = 0`, before any reviewer is spawned:
  1. `pr_diff` on the ticket's PR. Lines changed are the diff's added and removed lines (not the `+++`/`---` headers).
  2. Lines changed at or above the size limit: review.
  3. Otherwise Haiku reads the diff and answers `{"review": true|false, "reason": "…"}`, `review` true when the change does any of: spans more than one module, service or datastore; changes a schema or adds a migration; changes a published contract (API, event, config key, tool); touches auth, permissions, secrets, payments or crypto.
  4. Review: the reviewers start as today. No review: `pr_ready` on the PR, then the ticket goes to `pr_open`.
  - Each outcome logs one line with the reason.
  - With no tracker tool, a tracker error or no Haiku answer, the ticket stays at `review` with `started = 0`, the failure is logged, and the next pass tries again. It counts toward the one-ticket-at-a-time limit meanwhile.
- **The size limit** is `Review size: <lines>` in `routing.md`, read like the other settings, default 300.
- **Removed:** `Review threshold:` and the code reading it. A leftover line in an existing `routing.md` is ignored. There is no switch to turn agent review off.
- **The checks are in code,** in the Haiku prompt, not in `routing.md`.
- **Unchanged:** triage, difficulty and model routing; reviewers, verifier and fixer, all on the models they use today.

## Testing Decisions

- Test through the loop's `pass` and the `report_result` handling, with a fake tracker and a stubbed `complete`.
- **`report_result`:** an implementer's PR at stage `implement` moves to `review` whatever the difficulty.
- **The loop:**
  - the implementer's spawn prompt always asks for a draft;
  - a diff at or above the size limit starts both reviewers without asking Haiku;
  - a small diff Haiku says needs review starts both reviewers;
  - a small diff Haiku says needs none calls `pr_ready` and moves the ticket to `pr_open`, starting nobody;
  - a failing `pr_diff` leaves the ticket at `review`, not started, and logs the failure.
- **`Review size:`** read with its default, tested like the other `routing.md` settings.
- Prior art: the existing loop tests' `fakeTracker` and `deps`, `test/result.spec.ts`, the `limitsFrom` tests.

## Out of Scope

- Making the checks tunable per project.
- A switch to turn agent review off.
- Changing which model reviews.

## Further Notes

- Builds on docs/specs/tracker-mod.md (ticket 27): it needs the tracker tool's `pr_diff` and `pr_ready`.
