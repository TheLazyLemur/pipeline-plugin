# pipeline-plugin

- When code moves a ticket back to an earlier status, reset in the same statement every column that only the
  later status sets (for example `owner` and `owner_seen` on `in_progress`).
- Every tool registered with `$.tool.register` sets `isDeferred: false`. Left out, the tool sits behind ToolSearch,
  where an agent may not find it.
- A registration only declares a tool; its `tool.call` hook is the implementation. A tool or hook that must serve the
  loop's agents goes in `pipeline-agents`, never in `pipeline`: a plugin's hooks never run for agents that plugin
  spawned (see `docs/adr/0001`). Matchers do not matter.
- Every tool gets a `claude plugin test` (`npm run test:plugin`) that calls it from an agent the other plugin
  spawned, proving the hook answers it through the engine. See `pipeline-agents/test/report-result.test.ts`.
