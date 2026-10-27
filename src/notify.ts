import { DB, type Run, type Status, type Ticket, lit, sql } from '../pipeline-agents/src/store.ts'

type Message = { title: string; tags: string; click: string | null; body: string }

/** The statuses that need the user, and the notification each sends. */
const MESSAGES: Partial<Record<Status, (t: Ticket) => Message>> = {
  needs_human: t => ({ title: `${t.ticket_id} needs you`, tags: 'question', click: t.url, body: `${t.title}\n\n${t.question ?? ''}` }),
  pr_open: t => ({ title: `${t.ticket_id}: PR ready for review`, tags: 'eyes', click: t.pr_url ?? t.url, body: `${t.title}\n${t.pr_url ?? ''}` }),
  done: t => ({ title: `${t.ticket_id}: PR merged`, tags: 'tada', click: t.pr_url ?? t.url, body: `${t.title}\n${t.pr_url ?? ''}` }),
}
const NOTIFIED = `(${Object.keys(MESSAGES).map(lit).join(', ')})`

/** Run before a pass changes anything: a ticket that has left a notified status is notified again if it returns. */
export const forgetLeft = (run: Run) => sql(run, DB, `update tickets set notified_status = status where status not in ${NOTIFIED} and status is not notified_status`)

/** Posts to the ntfy topic URL in `.claude/pipeline/ntfy-url` once per ticket that entered a status needing the user; without the file, marks them notified unsent. A failed post is logged and retried next pass. Resolves what to log. */
export const notify = async (run: Run): Promise<string[]> => {
  const file = await run(['cat', '.claude/pipeline/ntfy-url'])
  const url = file.exitCode === 0 ? file.stdout.trim() : ''
  if (url === '') {
    await sql(run, DB, `update tickets set notified_status = status where status in ${NOTIFIED} and status is not notified_status`)
    return []
  }
  const due = (await sql(run, DB, `select ticket_id, title, url, status, question, pr_url from tickets where status in ${NOTIFIED} and status is not notified_status order by rowid`)) as Ticket[]
  const log: string[] = []
  for (const t of due) {
    const m = MESSAGES[t.status]!(t)
    const r = await run(['curl', '-fsS', '-m', '5', '-H', `Title: ${m.title}`, '-H', `Tags: ${m.tags}`, ...(m.click ? ['-H', `Click: ${m.click}`] : []), '--data-raw', m.body, url], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) log.push(`${t.ticket_id} notification failed: ${r.stderr.trim() || `curl exited ${r.exitCode}`}`)
    else await sql(run, DB, `update tickets set notified_status = ${lit(t.status)} where ticket_id = ${lit(t.ticket_id)} and status = ${lit(t.status)}`)
  }
  return log
}
