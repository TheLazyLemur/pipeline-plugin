import { type Run, lit, sql } from './store.ts'

export type Result = { status: 'pr_open'; pr_url: string } | { status: 'needs_human'; question: string }

/** Reads an implementer's final line, `PR: <url>` or `BLOCKED: <question>`; throws on anything else. */
export const parseResult = (answer: string): Result => {
  const last = answer.trimEnd().split('\n').at(-1)?.trim() ?? ''
  const pr = last.match(/^PR: (\S+)$/)
  if (pr?.[1] !== undefined) return { status: 'pr_open', pr_url: pr[1] }
  const blocked = last.match(/^BLOCKED: (.*\S.*)$/)
  if (blocked?.[1] !== undefined) return { status: 'needs_human', question: blocked[1].trim() }
  throw new Error(`no PR: or BLOCKED: final line: ${last.slice(0, 200)}`)
}

/** Writes an implementer's answer to its ticket, unless the ticket left `in_progress` meanwhile. Resolves what to log. */
export const record = async (run: Run, db: string, ticketId: string, answer: string): Promise<string> => {
  let r: Result
  try {
    r = parseResult(answer)
  } catch {
    // the end of the answer is where an agent says why it stopped
    const question = `The implementer ended without a PR: or BLOCKED: line. Check its branch, then send the ticket back to new. It ended with: ${answer.trim().slice(-500)}`
    r = { status: 'needs_human', question }
  }
  const set = r.status === 'pr_open' ? `pr_url = ${lit(r.pr_url)}` : `question = ${lit(r.question)}`
  await sql(run, db, `update tickets set status = ${lit(r.status)}, ${set} where ticket_id = ${lit(ticketId)} and status = 'in_progress'`)
  return r.status === 'pr_open' ? `${ticketId} has a PR: ${r.pr_url}` : `${ticketId} needs you: ${r.question}`
}
