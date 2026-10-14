---
name: pipeline-status
description: Show where every pipeline ticket stands and answer the ones waiting on you (needs_human). Use when the user asks what the pipeline is doing, what needs them, or wants to unblock a ticket.
---

# Pipeline status

The database is `.claude/pipeline/pipeline.db`, table `tickets`, read and written with the `sqlite3` CLI.

1. Show the counts by status:
   `sqlite3 -box .claude/pipeline/pipeline.db "select status, count(*) as n from tickets group by status"`
2. Show what is in progress, with its stage (implement, review, verify or fix), and the open PRs:
   `select ticket_id, title, model, case status when 'in_progress' then 'in_progress (' || coalesce(stage, 'implement') || ')' else status end as status, pr_url from tickets where status in ('in_progress', 'pr_open')`
3. List the held tickets: waiting in the tracker but kept out of the table by a blocker not yet done. Run the
   `## List the blockers` and `## List the tickets waiting to be worked` commands from
   `.claude/pipeline/tracker.md` live, from the project root. For each waiting ticket with rows whose
   `blocker_done` is false, show its id and title and the ids holding it. Point out tickets that hold each other
   (a cycle). The user releases a cycle, or a ticket held by a blocker that will never merge, by unlinking or
   closing tickets in the tracker. Say "none held" when there are none.
4. List the tickets that need the user, with their question and the triage reason:
   `select ticket_id, title, question, reason from tickets where status = 'needs_human'`
5. Go through them one at a time, asking the user each question. The user may skip any. For each answer:
   - Save it to the ticket on the tracker as a comment, following `.claude/pipeline/tracker.md`, so the
     implementer reads it.
   - Send the ticket back: to `ready` if it already has a model and the answer only fills the gap, else to `new`
     so it is triaged again. Clear the question:
     `update tickets set status = '<ready|new>', question = null where ticket_id = '<id>'`
     Double any `'` inside a value.
