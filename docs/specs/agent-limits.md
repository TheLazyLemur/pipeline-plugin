# Agent limits

## Problem Statement

Nothing bounds a pipeline agent. An implementer, reviewer, verifier or fixer runs as long and spends as many tokens
as it likes. Because the loop runs one ticket at a time, a slow or stuck agent also holds up every ticket behind it,
and nobody finds out except by looking. In amrod, a read-only fable reviewer ran amrod's full solver test suite for
13+ minutes while four tickets waited; a two-hour stall or a runaway context would have looked the same.

## Solution

Every agent the loop spawns gets two limits per run: 500K tokens of context, counted exactly as Claude Code counts
it, and 2 hours of wall time. At 80% of either limit the agent is nudged to wrap up. At 100% every tool call except
`report_result` is refused, telling it to report now with what it has. If it still has not reported after two more
model requests, its requests stop and it ends. A report made in time stands; an agent that is stopped hard leaves its
ticket to a human, with a question naming the limit it hit. The limits live in `routing.md`, the same for every model
to start, so the user and `/learn` can tune them.

## User Stories

1. As a user, I want every pipeline agent bounded in time, so that a stuck agent never holds up the queue for long.
2. As a user, I want every pipeline agent bounded in context size, so that an agent working on a ticket too big for one PR is stopped and I am pulled in.
3. As a user, I want the token count to match what Claude Code shows for context, so that the number means what I already understand it to mean.
4. As a user, I want the limits in `routing.md`, so that I can tune them per project without touching the plugin.
5. As a user, I want sensible defaults (500K tokens, 120 minutes) when `routing.md` does not set them, so that existing projects are bounded with no re-setup.
6. As a user, I want the same limits for every model to start, so that I tune from evidence (ticket 22's usage) rather than guesses.
7. As a user, I want the implementer, both reviewers, the verifier and the fixer all bounded, so that read-only agents cannot run away either.
8. As a user, I want an agent nudged at 80% of a limit, so that it wraps up properly instead of being cut off mid-step.
9. As a user, I want each nudge sent once per limit, so that the agent is not nagged on every tool call.
10. As a user, I want an agent at its limit to be told to report what it has, so that I get its account of where it stopped.
11. As a user, I want an agent that ignores that to be stopped after two more model requests, so that it is guaranteed to end.
12. As a user, I want a report made within the grace to stand (a PR, a blocked question, a verifier's count), so that work finished at the last moment is not thrown away.
13. As a user, I want a hard-stopped agent's ticket to go to needs_human with a question naming the limit it hit, so that I know why it stopped.
14. As a user, I want a restarted agent (ticket 21's restart) to start with fresh limits, so that a restart is a real second chance.
15. As a user, I want limit state to survive a plugin reload or a session restart, so that a reload neither resets a limit nor loses a nudge.
16. As a user, I want a log line when an agent is nudged, soft-stopped or hard-stopped, so that I can see it happening.
17. As a user, I want the limits to apply only to the pipeline's own agents, so that my main session and other subagents are untouched.

## Implementation Decisions

- **Measured per agent run:** context tokens and wall time, whichever reaches its limit first.
  - **Context tokens:** the input side of the agent's latest model request: uncached, cache-written and cache-read tokens together, read from the `usage` of each model request's result. This is how Claude Code computes the status line's context figure.
  - **Wall time:** from the agent run's start (its first model request) to now.
- **Configuration in `routing.md`:** `Agent token limit: <n>` and `Agent time limit: <minutes>`, parsed like `Review threshold:`. Missing lines mean 500000 and 120. One pair of limits for every model and role.
- **Bounded agents:** every agent spawned by the `pipeline` plugin for a ticket (implementer, reviewer-spec, reviewer-quality, verifier, fixer), recognised as `report_result` already recognises them.
- **Nudge at 80%** of either limit, once per limit per run: a note attached to the agent's next tool result: "You've used 80% of your <token|time> limit. Finish the step you're on, push what you have, and report. Don't start new work."
- **Soft stop at 100%:** every tool call except `report_result` is refused with "Limit reached (<which>): call report_result now with what you have."
- **Hard stop:** two model requests after the soft stop, if the agent still has not called `report_result`, its further model requests are answered without being sent, and it ends. The existing stop guard and orphan rule then send the ticket to needs_human; the question names the limit that was hit.
- **A report within the grace** is recorded as normal by `report_result`.
- **Where it lives:** entirely in `pipeline-agents`, which hears the loop's agents (docs/adr/0001): a model-request hook (usage, request count, hard stop), the tool-call hook (nudge, soft stop) and the bookkeeping. The `pipeline` plugin does not change.
- **Bookkeeping:** a new `agent_runs` table in `pipeline.db`, keyed by agent id: ticket, role, start time, latest context tokens, which nudges were sent, the request count at the soft stop. A restart is a new agent, so a new row with fresh limits. `pipeline-agents` runs `migrate()` itself on session start, so it never writes to a table the loop plugin has not created yet.
- **Logging:** one log line per nudge, soft stop and hard stop, naming the ticket, role and limit.

## Testing Decisions

- Test the decision and the bookkeeping, not the engine's internals.
- **The decision as a pure function** in `pipeline-agents/src/limits.ts`: given context tokens, start time, now, the limits and what the run has already been told, it returns nothing, a nudge (which limit), a soft stop or a hard stop. Node tests: either limit triggers; the nudge fires at 80% once per limit; the soft stop at 100%; the hard stop only after two more requests; a fresh run starts clean.
- **Reading the limits from `routing.md`** with defaults when absent, tested like `reviewFrom`.
- **The bookkeeping** through the store with a fresh database: a run's row is created, updated and read back; a second run of the same ticket gets its own row.
- **The hook wiring:** one `claude plugin test` that drives a pipeline agent past its limit through the engine and sees a non-`report_result` tool call refused, as ticket 15's test proved `report_result`.
- Prior art: `test/result.spec.ts` (the plain functions behind `pipeline-agents`), `reviewFrom`'s tests, and ticket 15's plugin test.

## Open Questions

- Whether a model request's `usage` is present for every request of a subagent. If it is missing on some, the token limit falls back to the last request that had it; the time limit always applies.

## Out of Scope

- Limits per model or per role (wait for ticket 22's numbers).
- Money estimates.
- Stopping a tool call that is already running: a limit takes effect at the agent's next tool call or model request.
- Limits on the main session or on agents the pipeline did not spawn.

## Further Notes

- Builds on docs/adr/0001: only `pipeline-agents` hears the loop's agents.
- Related: ticket 21 (restart once) gives a restarted agent a new run and so fresh limits; ticket 22 (usage per ticket) supplies the evidence for tuning the limits later.
