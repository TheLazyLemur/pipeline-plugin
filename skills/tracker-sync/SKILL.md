---
name: tracker-sync
description: Pull new and changed tickets from the tracker into the pipeline database. Run by the pipeline loop in the background; also safe to run by hand.
---

# Tracker sync

You run with no human watching: never ask anything, never edit code, never change the tracker. You only read the
tracker and write the pipeline database.

- Tracker instructions: `.claude/pipeline/tracker.md`. If it is missing, stop and answer "no tracker.md".
- Database: `.claude/pipeline/pipeline.db`, table `tickets`, through the `sqlite3` CLI. Double any `'` inside a
  value.

1. List the tickets waiting to be worked, as tracker.md says. Skip any epic or other parent ticket the list
   still returns. For each remaining ticket, check its blockers as tracker.md says (none if tracker.md has no
   section for them). A ticket with any blocker not in a done status is blocked:
   - if it is not in the table, skip it; it is pulled in once its blockers are done,
   - if it is in the table as `new` or `ready`, remove it: `delete from tickets where ticket_id = '<id>' and status in ('new', 'ready');`
   - otherwise leave it.

   Upsert every ticket that is not blocked:
   ```sql
   insert into tickets (ticket_id, title, url) values ('<id>', '<title>', '<url>')
   on conflict (ticket_id) do update set title = excluded.title, url = excluded.url;
   ```
   A new row starts as `new`; never change the status of an existing one here.
2. For every row whose status is not `done`, check whether the tracker now has it in a done status (per the
   mapping in tracker.md). If so: `update tickets set status = 'done' where ticket_id = '<id>';`
3. Answer with one line: how many tickets were added, updated, held back as blocked and marked done.
