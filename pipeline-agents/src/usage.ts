import type { AgentInfo, TurnCompleteInput } from 'claude-code'
import { agentOf } from './agents.ts'
import { type Run, lit, sql } from './store.ts'

/**
 * Records one finished turn of a pipeline agent in `turns`, against its ticket and role: the tokens and model
 * `turn.complete` reports (zero and null when it reports none, as on an interrupt) and its duration. Resolves
 * whether the agent was a pipeline agent, so a row was written.
 */
export const recordTurn = async (run: Run, db: string, plugin: string, agent: AgentInfo | undefined, e: Pick<TurnCompleteInput, 'usage' | 'durationMs'>): Promise<boolean> => {
  const who = agentOf(agent, plugin)
  if (who === null) return false
  const u = e.usage
  const values = [who.ticket, who.role, u?.model ?? null, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_read_input_tokens ?? 0, u?.cache_creation_input_tokens ?? 0, Math.round(e.durationMs)]
  await sql(run, db, `insert into turns (ticket_id, role, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms) values (${values.map(lit).join(', ')})`)
  return true
}
