# pipeline-tui

A keyboard-first terminal UI for one project's pipeline. It shows where every ticket stands and lets you file new
work into the tracker, with a triage preview first. It needs no agent and no Claude session. It reads
`.claude/pipeline/pipeline.db` with the `sqlite3` CLI and does everything else through the plugin's CLI,
`node <plugin>/bin/pipeline.ts`.

## Run it

```sh
cd tui
go build -o pipeline-tui .
./pipeline-tui --plugin ~/path/to/pipeline-plugin ~/path/to/project   # project defaults to the current directory
PIPELINE_PLUGIN=~/path/to/pipeline-plugin ./pipeline-tui              # or set the plugin once
go test ./...
```

Put flags before the project dir. It needs `node` (25 or later, which runs `.ts` directly) and `sqlite3` on the
`PATH`. It exits with an error when neither `--plugin` nor `$PIPELINE_PLUGIN` is set, or when the plugin dir has no
`bin/pipeline.ts`.

The tests need `node` and `sqlite3` too. They build their dbs from the `SCHEMA` in `pipeline-agents/src/store.ts`, so
they follow the plugin's schema, and run the CLI calls against `testdata/fake-plugin`.

To try it without a tracker or Haiku, point `--plugin` at `testdata/fake-plugin`. Its `tracker create` appends to
`<project>/.claude/pipeline/fake-tracker.jsonl`, and `FAKE_TRIAGE_DELAY_MS` slows its triage preview down to the
real one's pace.

## The screen

- **Left:** the tickets, grouped in this order: needs you (`needs_human`), ready, in progress (with its stage), PR
  open, new, done. Tickets you filed here and the loop has not synced yet sit on top as
  `filed #<id> · waiting for sync`, until the db has that id.
- **Centre:** the selected ticket from the db: title, url, status and stage, model, difficulty, confidence, PR url,
  tokens and minutes from `ticket_usage`, the question, the triage reason, the answers and the body.
- **Bottom:** the last result or error, the key hints, and a status bar with the project, counts per status and the
  time of the last refresh. The db is re-read every 5 seconds and on `r`.

## Keys

| key | action |
|---|---|
| `j` `k` / `↓` `↑` | move in the list, or scroll the page when it has focus |
| `tab` | switch focus between the list and the page |
| `o` | open the ticket's PR, or the ticket when it has no PR (`open` on macOS, `xdg-open` elsewhere) |
| `n` | write a new ticket in `$EDITOR` (`vi` when unset) |
| `N` | quick add: a title only, with an empty body |
| `r` | re-read the db |
| `esc` | clear the message line |
| `q` / `ctrl+c` | quit |

## Adding work

`n` writes a draft to a temp file (`pipeline-ticket-*.md`) and opens it in `$EDITOR`, which may carry arguments
(`code --wait`). The draft has a title line, `## What and why`, `## Acceptance criteria`, `## Out of scope`, a
`blocked-by:` line, and the project's `.claude/pipeline/readiness.md` in a comment as a reminder. On save:

- `<!-- … -->` comments are stripped;
- the title is the first non-empty line, without its leading `#`s;
- each `blocked-by:` line leaves the body, and its comma-separated ids (a leading `#` is dropped) become blockers;
- an empty title discards the draft and deletes the file.

`triage-preview` then runs in the background; the list keeps working while the message line shows `triaging…`. Its
verdict opens in a modal:

| key | action |
|---|---|
| `enter` | file it: `tracker create`, then `tracker link-blocker` for each blocker. The modal warns first when the verdict is `needs_human`: the ticket will wait for your answer in `/pipeline:pipeline-status`. A failed create keeps the modal open with the error, so `enter` retries |
| `e` | reopen the editor with triage's question as a comment at the top, then preview again |
| `esc` | discard; the draft file stays and the message line shows its path |

`N` asks for a title in a one-line box, then takes the same preview, file and blockers path with an empty body. `e`
on its verdict writes a draft file with that title, so you can add the body.

A filed draft's file is deleted. Errors from the CLI (its one-line stderr) show on the message line.

## Not built

- No editing or answering of existing tickets: answer questions in `/pipeline:pipeline-status`.
- No held-ticket view: a filed ticket with an unfinished blocker stays `waiting for sync` until the loop takes it in.
- `filed` rows live in memory only. Quit and they are gone from the list, though the tickets are in the tracker.
- The done group is listed in full, last, rather than collapsed.
