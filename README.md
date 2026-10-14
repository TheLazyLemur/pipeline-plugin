# pipeline

A Claude Code plugin that works your ticket board in the background. A loop syncs tickets from your tracker,
Haiku triages each one, and the model it routes to implements it in its own git worktree and opens its own PR.
You keep the main thread for spec, plan and review, and are only pulled in when a ticket needs you.

## Run it

Load the plugin for one session:

```sh
claude --plugin-dir /path/to/pipeline-plugin
```

Then, in your project:

| command | what it does |
|---|---|
| `/pipeline:tracker-setup` | Connects the pipeline to your tracker and writes `.claude/pipeline/tracker.md`. Run once per project, and again to switch tracker. |
| `/pipeline:pipeline-status` | Shows where every ticket stands and lets you answer the ones in `needs_human`. |
| `/pipeline:learn` | Works through review comments on the pipeline's PRs with you and changes the file that would have prevented each problem. |

Once `/pipeline:tracker-setup` has run, the loop starts with the session: the first pass runs 10 seconds after start,
then one pass every 5 minutes. Pipeline state lives in `.claude/pipeline/pipeline.db`.

## One loop pass

```mermaid
flowchart TD
    start([Timer fires]) --> setup{"`.claude/pipeline` set up?"}
    setup -- no --> stop(["Log: run /tracker-setup"])
    setup -- yes --> merged[Each pr_open ticket whose PR merged: mark done in the tracker and the table]
    merged --> sync[Sync: pull new and changed tickets from the tracker, holding back any with a blocker not done]
    sync --> triage[Triage every new ticket with Haiku]
    triage --> verdict{Ready?}
    verdict -- no --> nh[needs_human: question stored on the ticket]
    verdict -- yes --> ready[ready: difficulty scored, model routed]
    ready --> busy{A ticket already in_progress?}
    busy -- yes --> wait([Wait for the next pass])
    busy -- no --> impl[Spawn the routed implementer: sonnet, opus or fable]
    impl --> pr[Implement, run tests, open PR, status pr_open]
    impl -. blocked .-> nh
    nh --> you[You answer in /pipeline:pipeline-status]
    you -- "back to new or ready" --> triage
```

The loop never waits on a human: anything it cannot decide is set to `needs_human` with its question, and the
pass moves on. An `in_progress` ticket whose implementer is no longer running also goes to `needs_human`.
A ticket blocked by another in the tracker is held until its blocker is done; marking merged PRs done before
sync releases it in the same pass, so it is built on its blocker's merged code. `/pipeline:pipeline-status`
lists held tickets and what holds each.
