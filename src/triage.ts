import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'
import { type Run, type Ticket, lit, sql } from './store.ts'

/** The shape of `$.model.complete`. */
export type Complete = (request: ModelCompleteRequest) => Promise<ModelCompleteResult>

/** The project's own guides, `.claude/pipeline/<name>.md`. */
export type Guides = { readiness: string; rubric: string; routing: string }

/** The models with an implementer agent, `agents/implementer-<model>.md`. */
export const MODELS = ['sonnet', 'opus', 'fable'] as const

/** The tier above each model, which reviews its work. */
export const UP: Record<(typeof MODELS)[number], (typeof MODELS)[number]> = { sonnet: 'opus', opus: 'fable', fable: 'fable' }

/** The difficulty at and above which a ticket is reviewed, from routing.md's `Review threshold: <n>` line. */
export const reviewFrom = (routing: string): number => {
  const line = routing.match(/^review threshold:(.*)$/im)
  // a routing.md written before the threshold existed gets the default, so no re-setup is needed
  if (line === null) return 3
  const n = Number((line[1] ?? '').trim())
  if (!Number.isInteger(n) || n < 1) throw new Error(`routing.md "Review threshold:" must be a whole number from 1, not ${JSON.stringify(line[1]?.trim())}`)
  return n
}

export type Verdict = {
  ready: boolean
  question: string | null
  difficulty: number
  confidence: number
  model: (typeof MODELS)[number]
  reason: string
}

const system = (g: Guides) => `You triage one ticket for an AI implementer that works without a human.
Judge readiness against the readiness guide, difficulty against the rubric, and pick the model from the routing table.

<readiness>
${g.readiness}
</readiness>

<rubric>
${g.rubric}
</rubric>

<routing>
${g.routing}
</routing>

Reply with only this JSON object:
{"ready": true|false, "question": "what a human must answer, when not ready, else null", "difficulty": 1-5, "confidence": 0-1, "model": "sonnet"|"opus"|"fable", "reason": "one or two sentences"}`

/** Reads Haiku's reply; throws when it is not the verdict the prompt asked for. */
export const parseVerdict = (text: string): Verdict => {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const v = JSON.parse(json) as Verdict
  const ok =
    typeof v.ready === 'boolean' &&
    Number.isInteger(v.difficulty) && v.difficulty >= 1 && v.difficulty <= 5 &&
    typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 &&
    MODELS.includes(v.model) &&
    typeof v.reason === 'string' &&
    (v.ready || (typeof v.question === 'string' && v.question.trim() !== ''))
  if (!ok) throw new Error(`not a triage verdict: ${text.slice(0, 200)}`)
  return { ...v, question: v.ready ? null : v.question }
}

/** Triages one ticket with Haiku and writes the verdict, unless the ticket left `new` meanwhile. */
export const triage = async (run: Run, complete: Complete, db: string, guides: Guides, t: Pick<Ticket, 'ticket_id' | 'title' | 'url' | 'body'>) => {
  const r = await complete({
    model: 'haiku',
    system: system(guides),
    prompt: `Ticket ${t.ticket_id}: ${t.title}\n${t.url ?? ''}\n\n${t.body ?? '(no description)'}`,
    effort: 'low',
    timeoutMs: 60_000,
  })
  if (!r.isAnswered) throw new Error(`triage of ${t.ticket_id}: no answer (${r.reason})`)
  const v = parseVerdict(r.text)
  await sql(run, db, `update tickets set
      status = ${lit(v.ready ? 'ready' : 'needs_human')}, question = ${lit(v.question)},
      difficulty = ${lit(v.difficulty)}, confidence = ${lit(v.confidence)}, model = ${lit(v.model)}, reason = ${lit(v.reason)}
    where ticket_id = ${lit(t.ticket_id)} and status = 'new'`)
  return v
}
