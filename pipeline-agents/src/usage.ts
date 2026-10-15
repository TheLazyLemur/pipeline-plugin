import type { AgentInfo, TurnCompleteInput } from 'claude-code'
import { agentOf } from './agents.ts'
import { type Run, lit, sql } from './store.ts'

/** The ticket and role an agent's turns count against: its own, or its nearest ancestor's the loop spawned. */
const ownerOf = (agents: AgentInfo[], agentId: string, plugin: string) => {
  const seen = new Set<string>() // a parentId cycle ends the walk instead of looping
  for (let id: string | undefined = agentId; id !== undefined && !seen.has(id); ) {
    seen.add(id)
    const agent = agents.find(a => a.id === id)
    const who = agentOf(agent, plugin)
    if (who !== null) return who
    id = agent?.parentId
  }
  return null
}

/**
 * Records one finished turn in `turns`, against the ticket and role of the pipeline agent it ran for (the agent
 * itself, or the pipeline agent beneath which an Agent call or fork spawned it): the tokens and model
 * `turn.complete` reports (zero and null when it reports none, as on an interrupt) and its duration. Resolves
 * whether a row was written.
 */
export const recordTurn = async (run: Run, db: string, plugin: string, agents: AgentInfo[], agentId: string, e: Pick<TurnCompleteInput, 'usage' | 'durationMs'>): Promise<boolean> => {
  const who = ownerOf(agents, agentId, plugin)
  if (who === null) return false
  const u = e.usage
  const values = [who.ticket, who.role, u?.model ?? null, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_read_input_tokens ?? 0, u?.cache_creation_input_tokens ?? 0, Math.round(e.durationMs)]
  await sql(run, db, `insert into turns (ticket_id, role, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms) values (${values.map(lit).join(', ')})`)
  return true
}
