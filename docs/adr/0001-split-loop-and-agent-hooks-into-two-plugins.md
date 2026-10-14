---
status: accepted
---

# Split the loop and the agent hooks into two plugins

The engine never runs a plugin's hooks for an agent that the same plugin spawned from its own code. Every pipeline agent is spawned from the loop's clock timer, so the hooks that serve those agents (the `report_result` tool's `tool.call` handler, the `pipeline.db` Bash guard, the `tool.check` permission allow and the `SubagentStop` guard) never ran for them. A second plugin's hooks do hear them, and a plugin may have only one hooks module. So we ship two plugins from this repo: `pipeline` runs the loop (timer, sync, triage, spawning) and declares `pipeline-agents` as a dependency; `pipeline-agents` holds every hook that must hear the loop's agents. Both share `.claude/pipeline/pipeline.db`. This is a workaround for engine behaviour, not a design we wanted.

## Considered Options

- **Go back to the implementer's final line, read in `turn.complete`.** That event does reach timer-spawned agents, but it gives up the schema-checked tool, the stop guard, the database guard and the permission allow.
- **Spawn agents from a context the engine does not count as the plugin's own** (inside the `session.start` dispatch). That only works at session start, not from the loop's timer.
- **Wait for an engine change.** Reported, but out of our control.

## Consequences

- Installing the pipeline means two plugins; the dependency declaration should bring the second one along, and `--plugin-dir` takes both folders.
- A hook that must see the loop's agents goes in `pipeline-agents`, never in `pipeline`. Putting it in `pipeline` looks correct and silently never runs.
- If the engine starts letting a plugin hear the agents it spawns, the two can merge back into one.

Evidence: the debug line `tool.call skipped: re-entry (the plugin's own code raised it)` from ticket 12's probe runs, and the engine types: "An agent's start skips the hooks its spawn was nested in" and "no hook runs under its own frame".
