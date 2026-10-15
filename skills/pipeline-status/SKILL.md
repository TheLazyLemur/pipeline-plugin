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
3. Show what each ticket cost, recorded from its agents' turns: per ticket, the total tokens (input, output, cache
   read and cache write) and minutes, then the breakdown per role with the model it ran on. Say "nothing recorded"
   when both are empty.
   `select u.ticket_id, t.title, u.tokens, u.minutes from ticket_usage u left join tickets t using (ticket_id) order by u.ticket_id`
   `select ticket_id, role, model, turns, tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, minutes from role_usage order by ticket_id, role`
4. List the held tickets: waiting in the tracker but kept out of the table by a blocker not yet done. Call the
   project's `tracker` tool (`mcp__pipeline-tracker__tracker`) live with `op: "blockers"` and `op: "waiting"`.
   For each waiting ticket with rows whose `blocker_done` is false, show its id and title and the ids holding it. Point out tickets that hold each other
   (a cycle). The user releases a cycle, or a ticket held by a blocker that will never merge, by unlinking or
   closing tickets in the tracker. Say "none held" when there are none.
5. List the tickets that need the user, with their question and the triage reason:
   `select ticket_id, title, question, reason from tickets where status = 'needs_human'`
6. Go through them one at a time, asking the user each question. The user may skip any. For each answer:
   - Save it to the ticket on the tracker as a comment (`tracker` tool, `op: "comment"` with `id` and `text`), so
     the implementer reads it.
   - Send the ticket back: to `ready` if it already has a model and the answer only fills the gap, else to `new`
     so it is triaged again. Clear the question:
     `update tickets set status = '<ready|new>', question = null where ticket_id = '<id>'`
     Double any `'` inside a value.
