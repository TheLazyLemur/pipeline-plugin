# Dependency flow

## Problem Statement

When one ticket depends on another, the loop can implement the dependent before the blocker's PR is merged.
The dependent is then written against code that does not exist on `main` yet, and its PR needs rework at
merge (ticket 4 in the first test run). Sync can already hold back tickets with unfinished blockers, but a
blocker only counts as finished when the tracker says `done`, and nothing in the pipeline moves a ticket to
`done` when its PR merges. Blockers therefore never clear unless the tracker automates it or the user marks
tickets done by hand. Held tickets are also invisible: they never enter the pipeline table, so a cycle or a
blocker that never merges stalls silently.

## Solution

Whoever creates a ticket declares "blocked by" links in the tracker. Each loop pass, before syncing, the
loop checks every ticket with an open PR; when its PR has merged, it marks the ticket done in the tracker
and in the pipeline. Sync then releases any dependents in the same pass, so they are built on merged code.
Tickets without links are unaffected and keep flowing. `/pipeline-status` lists held tickets and what holds
each. The plugin stays provider-agnostic: both new steps are commands each project writes in tracker.md.

## User Stories

1. As a ticket creator, I want to mark a ticket as blocked by another in my tracker, so that the pipeline does not start it early.
2. As a ticket creator, I want tickets with no links to start as soon as they are ready, so that independent work is not slowed.
3. As a reviewer, I want a dependent ticket's PR to be built on its blocker's merged code, so that I do not review stale work or rework it at merge.
4. As a user, I want a ticket marked done in the tracker when its PR merges, so that I do not update the tracker by hand.
5. As a user, I want dependents released in the same pass their blocker is marked done, so that there is no extra five-minute wait.
6. As a user on a tracker that already closes tickets on merge, I want the loop's done step to be harmless, so that nothing breaks or double-moves.
7. As a user, I want an open PR that has not merged to leave its ticket untouched, so that only merged work counts as done.
8. As a user, I want `/pipeline-status` to list held tickets with the tickets holding each, so that I can see stalls.
9. As a user, I want a dependency cycle to show up in `/pipeline-status` as tickets holding each other, so that I can break it.
10. As a user, I want a blocker whose PR was closed without merging to show its dependents as held, so that I can decide to unlink or close them.
11. As a user setting up a project, I want `/tracker-setup` to ask for the merge check and mark-done commands, so that the flow works on my tracker and PR host.
12. As a user with a tracker.md from before this change, I want every pass to fail loudly with "run /tracker-setup", so that blockers never silently stop clearing.
13. As a user, I want PR URLs and ticket ids passed to tracker commands as data, never as shell text, so that an agent-written URL cannot run commands.
14. As a user of GitHub, GitLab, Bitbucket, Jira or Linear, I want the plugin to hold no provider-specific code, so that my setup is only a matter of tracker.md commands.
15. As the person testing the plugin locally, I want the local SQLite tracker to support links and the two new commands, so that I can run the dependency flow end to end.
16. As the person testing locally, I want a recipe for filing a ticket blocked by another, so that I can set up a test quickly.

## Implementation Decisions

- **Clearing rule unchanged:** a blocker clears when its tracker ticket is in a done status. Sync's existing hold-back (skip, or remove while `new` or `ready`) stays as it is.
- **New done step in the loop pass, before sync:** for each `pr_open` ticket, run the merge check with its `pr_url`. If merged, run mark-done with its `ticket_id`, then set the row to `done`. A ticket with an unmerged PR is left alone.
- **Two new required tracker.md sections**, each the first fenced block under its heading, run from the project root:
  - `## Check whether a PR is merged`: receives the PR URL as `$1` and prints `{"merged": true}` or `{"merged": false}`. Anything else is an error.
  - `## Mark a ticket done`: receives the tracker ticket id as `$1` and moves it to the tracker's done status. A non-zero exit is an error.
- **Values are passed as positional arguments** (`sh -c '<command>' sh <value>`, read as `"$1"`), never by text substitution.
- **A tracker.md missing either section fails the pass** with "run /tracker-setup", matching the three sync commands.
- **`/tracker-setup`** asks for and checks the two new commands. Its guidance for the blockers command is unchanged.
- **`/pipeline-status`** runs the blockers command live and lists held tickets (blocker not done) with the ids holding each, alongside the waiting tickets' titles. No new status or column.
- **Local test tracker** (project data, not plugin code): a `links` table in `tracker.db` (ticket id, blocked-by id); a real blockers command joining it to blocker status; the merge check implemented with the GitHub CLI; mark-done as a status update; a recipe for filing a ticket with a "blocked by" link.

## Testing Decisions

- Test external behaviour of one loop pass: tracker state and pipeline rows before and after, not how the commands are called internally.
- Seam: the loop's `pass`, through the existing loop tests and `freshProject` helper. Its tracker.md commands run against a throwaway SQLite tracker so a merge changes tracker state inside the test. Cases:
  1. A merged PR marks the ticket done in the tracker and the table.
  2. An unmerged PR leaves the ticket `pr_open` and runs no mark-done.
  3. A dependent of a just-merged ticket is inserted as `new` in the same pass.
  4. A PR URL containing `;` and `$(…)` reaches the command as literal text.
  5. A tracker.md missing either new section fails the pass with "run /tracker-setup".
- Prior art: the sync tests' tracker.md fixture builder, and the loop tests' `deps` stub and `freshProject`.
- Not code-tested: the `/pipeline-status` held list and the local tracker's links, which are skill text and project data and are checked by a live run.

## Open Questions

None from the discussion.

## Out of Scope

- Inferring dependencies from ticket text.
- Stacked PRs (branching a dependent from its blocker's unmerged branch).
- Flagging blockers that never merge; they are only visible in `/pipeline-status`.
- Any gate on independent tickets, such as "one PR open at a time".
- Rebasing open PRs when `main` moves.

## Further Notes

- The loop takes ready tickets in insertion order; a held ticket that is released later is triaged and queued then, not at its original position.
- A tracker that already closes tickets on merge makes mark-done a no-op in practice; the command must succeed when the ticket is already done.
