# Routing

Difficulty (from rubric.md) to the model that implements the ticket.

| difficulty | model |
|---|---|
| 1-2 | sonnet |
| 3-4 | opus |
| 5 | fable |

Security-critical work (auth, payments, secrets, permissions, crypto) goes to fable whatever its difficulty.

## Review

Every PR opens as a draft. Once it is open, the loop reads its diff: a change of at least this many lines (added
plus removed) is reviewed by agents on opus before you see it. A smaller one is reviewed when it spans more than one
module or service, changes a schema or migration, changes a published contract, or touches auth, permissions,
secrets, payments or crypto. Any other PR is marked ready and comes straight to you.

Review size: 300

## Agent limits

Every agent the pipeline spawns runs within two limits: its context in tokens, as Claude Code's status line counts
it, and its wall time in minutes. At 80% of either it is told to wrap up; at the limit every tool call but
`report_result` is refused; two model requests later it is stopped and its ticket comes to you.

Agent token limit: 500000
Agent time limit: 120
