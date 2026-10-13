# Agentic Delivery Pipeline — Spec

A model-routing delivery pipeline built as a Claude Code mod (plugin) plus
skills. One interface for humans and agents: specs become epics/tickets,
tickets are triaged and routed to the right model tier, an implementer loop
produces PRs, and a learning loop traces every change request back to the
stage that should have caught it.

Mechanisms below were checked against Claude Code 2.1.296; evidence is in
RESEARCH.md. Items marked *unverified* have not been run.

## Overview

### Goals
- Match model + effort to each task so cost tracks the cost of being wrong.
- Keep the client's external tracker clean: it owns identity + status only.
- Run concurrently from day one — same code path for solo (local libSQL
  server) and team (shared Turso).
- Close the loop: PR-fix root causes feed back into routing and gates.

### Non-goals
- Review is out of scope — treated as an external audit run on produced PRs
  (Daniel's own review-assist tool).
- No per-request system-prompt injection (breaks prompt cache). For the same
  reason the main thread's model is not switched per step; routing happens at
  subagent spawn.

## Model tiering ladder
- security-critical + difficult, or high cost-of-being-wrong (payments, auth,
  migrations, concurrency) → Fable (alias `fable`)
- difficult → Opus
- mechanical with silent-failure risk → Opus or Sonnet (high effort)
- mechanical, loud failure (compiler/tests catch it) → Sonnet
- classification / summarisation → Sonnet-low or Haiku

Second dial: effort level. Sonnet-high can beat Opus-low. Split tasks across
tiers rather than one model per task. Bias routing upward; escalate a tier
after 2 failures rather than retrying the same tier.

## The 4-step pipeline
1. Human + Opus/Fable produce spec → epics → tickets. A fresh session or
   different strong model cold-reads the spec before it enters the pipeline.
2. Haiku classifier checks readiness (separate from difficulty) and assigns
   difficulty + failure_mode (loud/silent) with a confidence score.
   Deterministic hard floors run before scoring. Unready tickets return to
   step 1 with specific gaps listed. Mechanism: `$.model.complete` with
   `model: 'haiku'` and a JSON reply; the result is an object and must be
   checked for `isAnswered` (`$.model.classify` returns one label only, so it
   does not fit).
3. Difficulty + failure_mode pick model and effort via routing.yaml. Model is
   set per spawn (`$.agent.spawn({ model })`). Effort cannot be set per spawn:
   the mod registers one agent type per effort level and picks the type.
4. Human reads/tests the PR; a fresh Opus reviews in the background.

## Store
- External tracker: identity + status only.
- libSQL store ALWAYS owns workflow fields: difficulty, tier, attempts,
  inbox, logs, root causes. Never pollutes the client tracker.
- Two cases only: tracker + store, or store-only.
- Backend: local libSQL server (`turso dev --db-file <path>`) OR shared
  Turso — one build, addressed by URL in both modes, designed
  shared/concurrent from the start. The turso CLI cannot open a database file
  directly, so solo mode needs the local server running.
- Access: the mod has no SQLite driver and cannot import packages. It shells
  out through `$.process.run(['turso', 'db', 'shell', <target>, sql])`.
  - local target: `http://127.0.0.1:<port>`
  - remote target: `libsql://<db>-<org>.turso.io?authToken=<db token>`, or a
    database name with `turso auth login` / `TURSO_API_TOKEN`
  - Remote is *unverified*: the argv forms and three auth ways come from the
    CLI source, not a live run; that Turso accepts the `Authorization: Bearer`
    header the CLI sends, and remote latency, are untested. Local calls
    measured 9–16 ms.
- Store-access rule: all SQL goes through one `exec(sql)` wrapper that
  - hex-encodes every text value as `CAST(X'<utf-8 hex>' AS TEXT)` (the CLI
    has no parameter binding); integers asserted; identifiers are constants
  - selects/returns `json_object(…)` as a single column and parses stdout
    lines starting with `{` (the CLI has no JSON mode)
  - wraps every multi-statement write in `begin … commit` (a bare batch is
    not atomic)
  - treats only "exit 0 and stdout parses" as success
  - passes SQL on stdin when it is too large for argv (~1 MB); a single row
    is capped near 2 MB by the 4 MiB stdout limit
- `$.store` is for per-machine config and cache only (non-atomic, 4 MiB,
  one machine). No workflow state lives there.
- Tables: tickets, workflow, inbox, events, root_causes.

## Concurrency
- One mode: concurrent. Atomic claim as a single `UPDATE … WHERE … RETURNING`
  statement, leases, optimistic `version` column, retry on an empty result
  (the conflict signal). Identical code for both backends.
- Locking is the server's concern; the mod sets no WAL or busy_timeout.

## Tracker adapters
- Per-project and pluggable (Jira / GitHub Issues / Asana / Bitbucket).
- Mechanism: REST through `$.http.fetch` or a CLI (`gh`, `acli`) through
  `$.process.run`. No SDK packages — a mod cannot import them.
- Configured via /pipeline-setup skill with a smoke test.
- Sync rules: tracker owns identity+status; store owns everything else.
- Store-only mode supported.

## The mod
- Claude Code plugin (mods on by default from v2.1.287 in the terminal,
  v2.1.286 in the Desktop app; machine runs 2.1.296). Minimum supported
  version: 2.1.287.
- Commands: /triage /implement /inbox /ticket /pr-fix /calibration
  (`/loop` is a built-in name and is refused at registration).
- Runs JS/TS in-process with no Node APIs and no package imports; everything
  outside goes through `$`. A hook has 10 s of its own time per event, so long
  work runs in timers or subagents.
- Uses:
  - `$.model.complete` (no-history calls)
  - routing at spawn: `$.agent.spawn({ model })`, one registered agent type
    per effort level, and an `agent.spawn` hook to re-route Agent-tool spawns.
    `turn.step` can change only model and effort and does not see the mod's
    own spawned subagents; use it only for main-thread effort.
  - `tool.call` / `tool.check` guards, each registered with a `.catch` that
    denies. Without it a failing guard is skipped (fails open).
    `claude plugin validate` must list no gating hook without `.catch`.
  - custom UI band (`ui.render` on `AbovePrompt`)
  - `$.session.send` for interactive session ↔ implementer session messages
  - `$.clock.every` for in-session cadence (fires while idle) and
    `$.prompt.submit` to start a turn from a timer
  - `session.start` for setup, plus `classic.SessionStart` to re-initialise
    after /clear, /resume and fork
- Risks: the mods API is early access and may change between releases; a
  remote rollout switch, `disableAllHooks`, or an organisation's managed
  settings can turn the mod off on a client machine.

## Implementer loop + PR contract
- 8-step iteration. Branch: pipeline/<ext_id>-<slug>. PR markdown template.
- Loops never block on humans — questions park in the inbox. The session is
  started daily by an external scheduler (cron/launchd or a routine); a mod
  cannot start a session and its timers end with the process.

## Inbox
- 3 item kinds. Assignee rules route questions to the right human.

## Learning loop
- /pr-fix flow: each change request traced to the stage that should have
  caught it, logged, turned into a pipeline fix on recurrence.
- Calibration log closes the loop between predicted and actual difficulty.

## Setup skill
- /pipeline-setup: 8 questions → project.yaml + smoke test.
- Also checks `turso --version` against a pinned minimum and records the
  store target and auth way per project.

## Operating it
- 2 sessions per project (interactive + implementer loop); triage in
  background. Status band preferred over a shared dashboard.
- The band draws only in the terminal and Desktop app. Headless, VS Code and
  cloud sessions report through command text and `$.ui.log`.
- 3 clients; ~2-hour slots across an 8-hour day with slack to the least
  resolved project.

## Open questions
- Does a mod committed under `.claude/skills/` pass the trust check and load
  in a cloud session? *Unverified* — needs one real cloud run. Docs say hooks
  run there for a plugin that reaches the session, and nothing draws.
- Remote Turso through the CLI: latency and the three auth ways are
  *unverified* — run the probe against a real database.
- Priority source: tracker field vs store ordering?
- Client contract restrictions on storing ticket content outside their tracker?
- Definition of "done" for calibration?
- Closed: `$.clock.every` runs while the session is idle (yes). A subagent's
  model can be pinned per spawn (yes); effort cannot.

## Operating lessons (from a manual dry run)
1. Loops must never block on permission prompts — use auto mode or pre-set
   approval rules for unattended sessions.
2. Read state from the store, not by scraping terminals — screen output is
   fragile and redraws truncate it.
3. Session-to-session relay needs a trusted channel (`$.session.send`), not
   simulated keystrokes.
4. The human decisions that arose were all inbox-shaped (merge/hold, which
   option, parallel or not), each presented with context and a
   recommendation.
