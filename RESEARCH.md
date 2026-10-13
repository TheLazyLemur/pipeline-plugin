# Research: SPEC.md vs the Claude Code mods API (2.1.296)

Date: 2026-10-13. Machine: Claude Code 2.1.296, macOS. SPEC.md was not edited; no project code was scaffolded.

Evidence labels used below:

- **[types]** — `claude-code.d.ts` written by the built-in `plugin-authoring` skill for this build (header: "Written by Claude Code 2.1.296", 21,461 lines). Line numbers refer to that file.
- **[skill]** — the `plugin-authoring` skill's `SKILL.md` / `reference.md` for 2.1.296.
- **[docs]** — code.claude.com/docs, fetched today.
- **[mods]** — `anthropics/claude-code/mods` at commit `bf2323b302` (2026-10-13).
- **[probe]** — a throwaway mod run from the session scratchpad with `claude -p --plugin-dir … --input-format stream-json` on this machine. Not kept in this repo.

Note: the `mods/types/claude-code.d.ts` published in the GitHub repo is headed "Written by Claude Code 2.1.277" and differs heavily from the local 2.1.296 file. Where they could differ, the local file was used.

---

## Verdicts

| # | Question | Verdict |
|---|---|---|
| 1 | Are the event names and `$` methods real? | All real. Three are described loosely enough in the spec to cause a wrong build: `$.session.send`, `$.store`, and "fail closed". |
| 2 | Does `$.clock.every` fire while idle? | Yes. Verified by probe: fires before any turn, during a turn, and after it. |
| 3 | Model per spawn? | Yes, model can be set per spawn. Effort cannot; effort is per agent type or per `turn.step`. |
| 4 | libSQL from a mod? | Both routes work on this machine. Recommended: libSQL HTTP (Hrana `/v2/pipeline`) via `$.http.fetch` for both backends. |
| 5 | Mods in cloud sessions? | Hooks run, nothing draws, and only for a plugin that actually reaches the cloud VM. How this mod would get there is unverified. |
| 6 | Anything the API cannot do? | Nine items, listed in section 6. The hard ones: `/loop` is refused, no npm imports, timers die with the process. |

---

## 1. Event names and `$` methods

All eleven names exist in 2.1.296.

| Name | Real | What it actually is | Evidence |
|---|---|---|---|
| `session.start` | Yes | Fires once when the session is ready, awaited before the first prompt. Input `{ cwd, surface, isInteractive }`. Does **not** fire again after `/clear`, `/resume`, `/branch`. Fires again on a hot reload. | [types] 11679–11702; [skill] reference.md "Work that outlives a dispatch"; [docs] interface.md "Load a saved value again after /clear" |
| `classic.SessionStart` | Yes | The settings-hook event as a function hook. Fires at start-up and after `/clear`, `/resume`, fork and compaction, with `e.source`. Use it to re-initialise after a reset. | [types] 1244, 1369, 11651; [docs] interface.md line 812 |
| `command.run` | Yes | Answers a slash command registered with `$.command.register({ name, description })`. Returns `{ text, context? }`. | [types] 1798–1930; [mods] diff/hooks/register.ts 793, 929 |
| `tool.call` | Yes | Hook returns `{ deny }`, rewrites with `next({...e})`, or awaits `next(e)` and reacts. | [types] 3962, 4516; [mods] sec-default/hooks/register.ts 181 |
| `tool.check` | Yes | The permission verdict. Refusal is `{ decision: 'deny' }`. | [types] 3976, 4520; [mods] sec-default 102 |
| `turn.step` | Yes | One model request inside a turn. Streaming: the hook **must** be an `async function*`. Only `model` and `effort` are rewritable; everything else is pinned. | [types] 13430–13470, 12179 |
| `turn.complete` | Yes | Carries `answer`, `durationMs`, `isAborted`, `turnId`, `agentId?`, `usage?`. Fires for subagent runs too. | [types] 13285–13332 |
| `ui.render` | Yes | The "custom UI band" is `on('ui.render', { component: 'AbovePrompt' }, …)`. | [skill] SKILL.md table; [docs] reference.md render sites |
| `$.model.complete` | Yes | One completion, no history, no tools. Takes `model` (alias or id), `prompt`, `system`, `effort`, `maxTokens` (default 1024), `timeoutMs`. Always resolves a result object: check `isAnswered`, it is never a bare string. | [types] 2600–2624, 6178–6260; [docs] reference.md limits |
| `$.model.fork` | Yes | One tool-less question over the session's own transcript, on the main thread's model. No model choice. Returns `nothing-to-fork` before the first turn. | [types] 2625–2643, 6349–6372 |
| `$.clock.every` | Yes | `(ms, fn) => Timer` with `cancel()`. See section 2. | [types] 3425–3475, 12630 |
| `$.store` | Yes | A per-plugin JSON key-value file under the Claude config directory, shared by every session on the machine. 4 MiB total. `get` then `set` is **not atomic**. | [types] 3352–3382; [docs] interface.md "Save from more than one session" |
| `$.session.send` | Yes | Sends a plain-text message to **another** session, a subagent or a teammate (the SendMessage delivery). It does not put text into the current session. | [types] 11515–11650; [docs] api.md 225–255 |

Also real and relevant, though the spec does not name them: `$.model.classify(text, labels)`, `$.agent.spawn`, `$.agent.register`, `$.prompt.submit`, `$.http.fetch`, `$.process.run`, `$.fs`.

Descriptions in the spec that need correcting:

- **"tool.call / tool.check guards (fail closed)"** — a hook that throws or overruns its budget is *skipped* and the call proceeds. Fail-closed needs an explicit `.catch` on each guard: `on(...).catch(($, e, next) => next.called ? next(e) : { deny: 'why' })`. `claude plugin validate` lists each gating hook with or without `.catch`. [skill] reference.md "Developing one"; [docs] events.md 342.
- **"$.store persistence"** — fine for config and caches, wrong for workflow state: no compare-and-set, 4 MiB cap, one machine. The docs state that two sessions race and the second write wins.
- **"$.session.send"** — correct only if the intent is the interactive session messaging the implementer session. To start a turn in the same session use `$.prompt.submit`; to add a row the model reads use `$.session.append`.
- **"mods on by default from v2.1.287"** — correct for the terminal; 2.1.286 for the Desktop app. [docs] overview.md line 97.

## 2. `$.clock.every` while idle

**Fires while idle.** Not tied to turns.

- [probe] A 1-second interval started in `session.start`, session held open with no input for 7 s, then one Haiku turn, then 22 s idle: ticks 1–6 arrived before `turn.start`, tick 7 during the turn, ticks 8–28 after `turn.complete`, each about 1,001–1,010 ms apart.
- [docs] api.md line 203: "The timer's callback runs outside any event, so it keeps running between turns and doesn't start one."
- [skill] reference.md: timers "run until cancelled or until the module reloads"; `$.prompt.submit` "queues a prompt that starts a turn of its own once the session is idle … so background work can wake a quiet session".
- [mods] `diff` polls git HEAD every 2,000 ms with `$.clock.every` while its pane is open (`hooks/register.ts` 294–315, `limits/timing/head-poll-ms.ts`).

Limits: a timer ends when the module hot-reloads, when the hooks worker is replaced, and when the process exits. A callback that throws is logged and the timer continues. The probe ran in headless stream-json mode, not the interactive REPL; the docs statement covers the general case.

## 3. Model per subagent spawn

**Model: per spawn. Effort: not per spawn.**

- `$.agent.spawn({ prompt, description?, subagentType?, model?, name?, cwd? })` — `model` is an alias or full id. [types] 251.
- An `agent.spawn` hook can rewrite `model` on spawns the model itself makes through the Agent tool: "A hook sets this to pick the subagent's model." Ignored for forks; workflow agents can only be refused. [types] 264–310.
- `AgentSpawnArgs` and `AgentSpawnInput` have no `effort` field. Effort is set in the agent definition (`AgentSpec.effort`, or `agents/*.md` frontmatter) or by rewriting `effort` in a `turn.step` hook. [types] 440–480, 13457.
- Catch: "A subagent a hook spawned through `$.agent.spawn` steps past that hook" — the mod's own `turn.step` hook does not see the steps of subagents the mod itself spawned. [types] 13466–13469. So for mod-spawned implementers, effort has to come from the agent type.

Practical shape: register one agent type per effort level with `$.agent.register` (or ship `agents/*.md`), and pick the model per spawn.

## 4. Reaching a libSQL store

A hooks module has no Node APIs and cannot import packages: only relative imports from the plugin folder plus the bare `claude-code` import; dynamic `import()` fails the load. [docs] create.md 314–316. [probe] confirmed `fetch`, `WebAssembly`, `require`, `process`, `WebSocket` are all `undefined` inside the module. So `@libsql/client`, `better-sqlite3` and a WASM SQLite build are all out.

Both candidate routes were run from a mod on this machine:

| Route | Result | Round trip |
|---|---|---|
| `$.process.run(['sqlite3', file, '-cmd', '.timeout 5000', sql])` | exit 0; `PRAGMA journal_mode=WAL` returned `wal`; `UPDATE … RETURNING` claim returned the row | about 13–50 ms (process start each call) |
| `$.http.fetch('http://127.0.0.1:18080/v2/pipeline', { method: 'POST', body })` against `turso dev --db-file` | HTTP 200; create, insert and `UPDATE … WHERE id=(SELECT …) RETURNING` in one pipeline, with typed args | 4 ms |

`sqlite3` 3.51.0 is at `/usr/bin/sqlite3`; `turso` and `sqld` are in `/opt/homebrew/bin`.

**Recommendation: Hrana over HTTP for both backends.** Local = `turso dev --db-file <path>` (or `sqld`) on localhost; team = Turso's URL with a bearer token. That is the only option that gives the spec's "identical code for both backends".

Reasons against the `sqlite3` CLI as the primary route:

- No parameter binding on the argv path, so ticket text has to be escaped into SQL by hand.
- A second code path for Turso anyway.
- `WAL` and `busy_timeout` only mean something here; over HTTP the server owns locking.

Constraints of the HTTP route:

- Solo mode needs a local libSQL server process running. The mod can start it with `$.process.spawn`, but that child dies when the module reloads.
- `$.http.fetch` bodies are text, responses cap at 4 MiB, 30 s per call. [docs] reference.md limits.
- Interactive transactions need Hrana batons across requests. Design every claim, lease renewal and version bump as a single statement or a single pipeline.
- `$.http.fetch` is refused where an organisation's web-fetch policy blocks the host. [types] 3480–3484.

Other options, not tested: an MCP server fronting the database, called with `$.tool.call`; a sidecar reached over a Unix socket (`$.http.fetch(url, { socketPath })`).

## 5. Cloud sessions

**Hooks run; drawing does not; getting the mod there is the open part.**

- [docs] overview.md "Where mods run": cloud session — hooks run "Yes, for a plugin that reaches the cloud session"; drawing "No". Same for `claude -p`, the Agent SDK and the VS Code panel: hooks yes, drawing no.
- [docs] cloud-environments.md "What carries over": plugins enabled only in user settings — No. Plugins and marketplaces declared in the repo's `.claude/settings.json` — No. The repo's `.claude/skills/` — Yes (part of the clone).
- [docs] plugins/loading.md: a plugin folder with a manifest under the project's `.claude/skills/` loads as `<name>@skills-dir`, but "only after the same trust check that applies to project allow rules … running with `-p` isn't enough", and a cloud session "never shows" the trust dialog.
- The changelog shows mods do execute there: 2.1.295 "Fixed cloud sessions hanging when a mod's `session.receive` hook asked for permission".

**Unverified:** whether a mod committed under `.claude/skills/pipeline/` loads its hooks module in a cloud session, given the trust rule above. I did not run a cloud session. Plugins synced from claude.ai (`<name>@synced`) are a second possible route, also untested.

Consequences if it does load: no band, no pane (use command text and `$.ui.log`); `$.store` is on the VM and lost with it; `sqlite3`/`sqld` may not be installed; the Turso host must be allowed by the environment's network settings.

## 6. What the spec asks for that the API cannot do

1. **`/loop` cannot be registered.** [probe] `$.command.register({ name: 'loop' })` rejects: `"/loop" refused: it is the built-in /loop`. `/triage` registered fine. `/inbox`, `/ticket`, `/pr-fix`, `/calibration` were not tested but are not built-in names in this session.
2. **Fail-closed is not the default.** See section 1.
3. **`$.store` cannot be the concurrent store.** See section 1.
4. **No npm or Node dependencies in the mod.** See section 4. Tracker adapters must talk REST through `$.http.fetch` or shell out (`gh`, `acli`) through `$.process.run`.
5. **"Loops restart daily" cannot be done from inside a mod.** Timers die with the process, and a mod cannot start a session. A daily restart needs something outside: cron/launchd running `claude -p`, or a routine.
6. **Hook time budget is 10 s of the hook's own time** (`$` calls and `next` are not counted; `$.clock.sleep` is). [types] 5107–5122. Long work belongs in timers or subagents, not in a `command.run` body.
7. **`turn.step` routing is narrower than "sits in the model-request path" suggests.** It can change `model` and `effort` only, cannot see or edit messages, and does not see the mod's own spawned subagents. My inference, not tested: switching the main thread's model per step re-bills the cached prefix (the `$.model.fork` doc says the prefix is "billed afresh … after `/model`"), which conflicts with the spec's prompt-cache non-goal.
8. **The status band only exists in the terminal and Desktop app.** A headless implementer-loop session, a VS Code panel session and a cloud session draw nothing.
9. **Mods can be switched off underneath you.** `disableAllHooks`, an organisation's `allowManagedModsOnly`, and a remote rollout switch all stop hooks modules. On a client machine with managed settings, `sec-default` is seated ahead of user mods. [docs] troubleshoot.md 28–30, admin.md. The API is labelled early access and "may change between releases without notice" [mods] README.

Smaller points:

- `$.model.classify` returns one label only. Step 2 needs readiness + difficulty + failure_mode + confidence, so use `$.model.complete` with a JSON reply.
- "Fable 5": the alias is `fable`; the current id is `claude-fable-5-1`.

---

## Recommended spec changes

1. Rename `/loop` (for example `/implement` or `/pipeline-loop`).
2. Store section: replace "local SQLite file OR shared Turso" with "libSQL over HTTP (Hrana `/v2/pipeline`) via `$.http.fetch`; local = `turso dev`/`sqld` on localhost, team = Turso". State that the mod has no SQLite driver.
3. Concurrency section: drop "WAL + busy_timeout" as mod-level concerns. Require every claim, lease and version bump to be a single statement or single pipeline. Keep optimistic versioning and retry-on-conflict.
4. Mod section: change "`$.store` persistence" to "`$.store` for per-machine config and cache only; all workflow state in libSQL".
5. Mod section: change "tool.call / tool.check guards (fail closed)" to "…each guard registered with a `.catch` that denies; `claude plugin validate` must list no gating hook without `.catch`".
6. Mod section: replace "turn.step routing" with "routing at spawn: `$.agent.spawn({ model })` plus one registered agent type per effort level; an `agent.spawn` hook to re-route Agent-tool spawns". Keep `turn.step` only if main-thread effort changes are wanted.
7. Mod section: state what `$.session.send` is for (interactive session ↔ implementer session), and add `$.prompt.submit` as the way a timer starts a turn.
8. Mod section: add `classic.SessionStart` for re-initialising after `/clear`, `/resume`, fork.
9. Classifier: say `$.model.complete` with `model: 'haiku'` and a JSON reply; note the result object must be checked for `isAnswered`.
10. Implementer loop: replace "loops restart daily" with an external scheduler (cron/launchd or a routine) that starts the session; in-session cadence via `$.clock.every`.
11. Operating: note the band is terminal/Desktop only; headless and cloud sessions report through command text and `$.ui.log`.
12. Tracker adapters: specify REST via `$.http.fetch` or CLI via `$.process.run`; no SDK packages.
13. Open questions: close "clock idle" (yes) and "per-spawn model" (yes; effort no). Replace "mod behaviour in cloud sessions" with the narrower open item: "does a `.claude/skills/` mod pass the trust check in a cloud session?" — needs one real cloud run.
14. Add a risk line: early-access API, remote rollout switch, and managed-settings blocks on client machines. Pin a minimum Claude Code version (2.1.287 terminal).

---

## Sources

- Local 2.1.296 declarations: `plugin-authoring/types/claude-code.d.ts` (bundled skill, regenerated each load)
- Local skill text: `plugin-authoring/SKILL.md`, `plugin-authoring/reference.md`
- https://code.claude.com/docs/en/plugins/mods/overview.md
- https://code.claude.com/docs/en/plugins/mods/api.md
- https://code.claude.com/docs/en/plugins/mods/reference.md
- https://code.claude.com/docs/en/plugins/mods/events.md
- https://code.claude.com/docs/en/plugins/mods/interface.md
- https://code.claude.com/docs/en/plugins/mods/create.md
- https://code.claude.com/docs/en/plugins/mods/troubleshoot.md
- https://code.claude.com/docs/en/plugins/mods/admin.md
- https://code.claude.com/docs/en/plugins/loading.md
- https://code.claude.com/docs/en/cloud-environments.md
- https://github.com/anthropics/claude-code/tree/main/mods (README, `diff`, `agents-md`, `sec-default`, `telemetry`) at `bf2323b302`
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.1.287–2.1.296 entries)

---

## Turso CLI route

Date: 2026-10-13. Decision under test: the mod reaches the store with `$.process.run(['turso', 'db', 'shell', …])` instead of Hrana over `$.http.fetch`. This supersedes the recommendation in section 4 and spec changes 2–3 above.

**Verdict: workable, with three things the mod must build itself — value escaping, JSON output, and error detection. Verified locally from a probe mod on turso CLI v1.0.15. The remote leg was not run live: the CLI is not logged in on this machine and no Turso database or token was available.**

Evidence labels: **[probe2]** a second throwaway mod run from the scratchpad against `turso dev --db-file … --port 18081`; **[shell]** the same CLI run directly; **[src]** `tursodatabase/turso-cli` `internal/cmd/db_shell.go`, `db.go`, `auth.go` at today's HEAD (may differ slightly from v1.0.15); **[capture]** a local HTTP listener recording what the CLI sent.

### (1) Local and remote, same command shape

Same shape: `turso db shell <target> <sql>`. Only the target differs.

```
local   ['turso', 'db', 'shell', 'http://127.0.0.1:8080', sql]
remote  ['turso', 'db', 'shell', 'libsql://<db>-<org>.turso.io?authToken=<db token>', sql]
remote  ['turso', 'db', 'shell', '<db-name>', sql]            // needs login or TURSO_API_TOKEN
```

- Local server: works with no login. [probe2], [shell]. [src] line 130: "Makes sure localhost URL or self-hosted will work even if not authenticated".
- **A local database file does not work.** `turso db shell /path/f.db "select 1;"` prints `Error: Binary was compiled with 'CGO_ENABLED=0', go-sqlite3 requires cgo to work` and exits **0**. `file:` URLs are rejected: "valid protocols are libsql://, wss://, ws://, https:// and http://". [shell]. So solo mode still needs `turso dev --db-file <path>` (or `sqld`) running, exactly as the Hrana route did.
- Remote: not run. The argv forms come from the CLI help and [src] 165–222.

### (2) Parameter binding

**None.** `turso db shell` takes a target and one SQL string; there is no args flag. [shell] help; [capture] shows the CLI sends `{"type":"execute","stmt":{"sql":"…","want_rows":true}}` with no `args`. Values must be written into the SQL text.

Proposed encoder — never build a quoted string from ticket text:

```ts
const hex = (s: string) =>
  "CAST(X'" + Array.from(new TextEncoder().encode(s), b => b.toString(16).padStart(2, '0')).join('') + "' AS TEXT)"
```

- Text → `CAST(X'<utf-8 hex>' AS TEXT)`. The literal contains only `[0-9a-f]`, so no input can close it.
- Integers → assert `Number.isSafeInteger`, then print. `null` → `NULL`. Anything else throws.
- Table and column names are constants in the mod, never data.

[probe2] A value containing `'`, `;`, `--`, `"`, a backslash, newline, CR, tab, accented characters, an emoji and the word `NULL` round-tripped byte-identical. Doubling single quotes also round-tripped for the same value, but it depends on the CLI's own statement splitter handling quotes correctly; hex does not.

Size: hex doubles the text. 400 KB of SQL in argv worked (24 ms). For larger payloads pass the SQL on stdin (`init.stdin`, no sql arg): 1.6 MB worked (61 ms). macOS caps argv at roughly 1 MB in total.

### (3) Machine-readable output

**No JSON mode.** Output is a padded text table with upper-cased headers. A real `NULL` and the string `'NULL'` print identically. [shell]. `.mode json` on stdin is not supported.

Workaround, verified: make SQLite produce the JSON, one column, one object per row.

```sql
select json_object('id', id, 'body', body) as j from q;
update q set … returning json_object('id', id, 'owner', owner, 'version', version) as j;
```

Parse rule: split stdout on `\n`, trim, keep lines that start with `{`, `JSON.parse` each. [probe2] parsed 3 rows; `"NULL"` and `null` came back distinct.

Things the parser must tolerate:

- Line 1 is the header (`J`). Rows carry trailing spaces.
- No rows → header only. DDL → empty stdout.
- With SQL on stdin, stdout starts with a spinner line `⣾  Connecting to database`.
- The header is padded to the widest row, so stdout is about twice the largest row. `$.process.run` keeps 4 MiB of stdout, which caps a single row near 2 MB.
- No `affected_row_count` or `last_insert_rowid`; use `RETURNING`.

### (4) Auth for remote inside `$.process.run`

The child runs as the session's user with the host environment plus `init.env`. Three ways, from [src]:

| Way | How | Notes |
|---|---|---|
| Token in the URL | `…turso.io?authToken=<db token>` (also `auth_token`, `jwt`) | No login needed. [capture] confirmed the CLI sends it as `Authorization: Bearer <token>`. The token is in argv, so `ps` and any mod hooking `process.run` can read it. |
| `TURSO_API_TOKEN` env | `$.process.run(argv, { env: { TURSO_API_TOKEN } })` with a db name | A platform API token (account-wide, not per database). The CLI resolves the database and mints a 2-day db token through the Turso API, then caches it in its settings file. |
| `turso auth login` | One-off, interactive, browser | Stored in `~/Library/Application Support/turso/settings.json`; later `$.process.run` calls pick it up. Not usable headless or in a cloud VM. |

With a `*.turso.io` URL and no token in it, the CLI falls back to the logged-in account. Not verified live.

### (5) Latency per call

- Local, through `$.process.run`: 10 sequential `select 1` calls took 9, 16, 11, 10, 10, 9, 9, 9, 10, 9 ms. Writes and claims 9–12 ms. [probe2]. Hrana via `$.http.fetch` measured 4 ms earlier.
- Remote: **not measured.** Each call is a new process and a new TLS connection, so expect network round trip plus handshake on every call; the db-name form adds Turso API calls when its token cache is cold. Measure with the same probe once a database exists.

### (6) Atomic claim and multi-statement batch

Both work. [probe2]

- Claim: `update q set owner='w1', version=version+1 where id=(select id from q where owner is null order by id limit 1) returning json_object(…)` returned `{"id":1,"owner":"w1","version":1}`.
- Optimistic miss: `… where id=1 and version=0 returning …` returned header only, exit 0. An empty result is the conflict signal.
- Six claims fired concurrently with `Promise.all` each got a different row (ids 2, 3, 5, 4, 6, 7), all exit 0.
- Batch in a transaction: `begin immediate; insert …; insert …; commit; select …` committed both rows.
- Failing transaction: `begin; insert …; insert into nope …; commit;` exited 1 with `Error: SQLite error: no such table: nope` on stderr, and the row count was unchanged.
- **A batch without `begin`/`commit` is not atomic.** [shell] Three statements with the second failing: the first insert stayed, the third never ran, exit 1. Every multi-statement write must be wrapped in a transaction.

### (7) What makes this worse than Hrana

1. No parameter binding; the mod owns an escaping layer and every query must go through it.
2. No structured output; the mod owns a `json_object` convention and a line parser.
3. Errors are stderr text plus an exit code, and the exit code is not always right (the file-path error exits 0). Treat "exit 0 and stdout parses" as success, everything else as failure.
4. A hard dependency on the `turso` binary, on every machine and in any cloud environment, pinned to a version; its output format is not a contract.
5. The remote token sits in argv or the mod needs an account-wide API token. Over `$.http.fetch` it would be a header.
6. It does not remove the local server. The CLI cannot open a file, so solo mode needs `turso dev` either way.
7. It is the same wire protocol with a wrapper on top: [capture] shows the CLI POSTs to `/v2/pipeline`.
8. Per-call process start, and for remote a fresh connection each time. Locally that is about 10 ms against 4 ms; negligible at this pipeline's volume.
9. Stdout cap limits a row to about 2 MB; argv cap forces a stdin path for large writes.

What it does better: with `turso auth login` and a db name, the mod handles no token at all, and the same command works by hand in a terminal for debugging.

### Spec changes if this route stands

- Store: "local SQLite file" becomes "local libSQL server (`turso dev --db-file`)"; the backend is addressed by URL in both modes.
- Add a store-access rule: all SQL goes through one `exec(sql)` wrapper that hex-encodes values, selects `json_object(…)`, wraps multi-statement writes in a transaction, and fails on a non-zero exit or unparseable stdout.
- Concurrency: drop WAL and `busy_timeout`; keep single-statement claims with `RETURNING`, optimistic `version`, and retry on an empty result.
- Setup skill: check `turso --version`, pin a minimum, and choose the auth way per project.
- Open item: run the probe against a real Turso database for remote latency and to confirm the three auth ways.
