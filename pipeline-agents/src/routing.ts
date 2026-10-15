import type { Run } from './store.ts'

/** `.claude/pipeline/routing.md`, or '' when there is none, so every setting reads as its default. */
export const readRouting = async (run: Run): Promise<string> => {
  const r = await run(['cat', '.claude/pipeline/routing.md'])
  return r.exitCode === 0 ? r.stdout : ''
}

/** routing.md's `<label>: <n>` line as a whole number from 1; `fallback` when the line is missing, so a routing.md written before it needs no re-setup. */
const whole = (routing: string, label: string, fallback: number): number => {
  const line = routing.match(new RegExp(`^${label}:(.*)$`, 'im'))
  if (line === null) return fallback
  const n = Number((line[1] ?? '').trim())
  if (!Number.isInteger(n) || n < 1) throw new Error(`routing.md "${label}:" must be a whole number from 1, not ${JSON.stringify(line[1]?.trim())}`)
  return n
}

/** The difficulty at and above which a ticket is reviewed, from routing.md's `Review threshold: <n>` line. */
export const reviewFrom = (routing: string): number => whole(routing, 'Review threshold', 3)

/** Each pipeline agent run's limits: context tokens and minutes of wall time, from routing.md's `Agent token limit:` and `Agent time limit:` lines. */
export type Limits = { tokens: number; minutes: number }

export const limitsFrom = (routing: string): Limits => ({ tokens: whole(routing, 'Agent token limit', 500_000), minutes: whole(routing, 'Agent time limit', 120) })
