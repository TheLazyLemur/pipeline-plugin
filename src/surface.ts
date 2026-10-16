import type { Complete } from './triage.ts'

/** Whether a PR is reviewed, and why. */
export type Surface = { review: boolean; reason: string }

/** The diff's added and removed lines, not counting the `+++`/`---` file headers. */
export const linesChanged = (diff: string): number => diff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l)).length

const SYSTEM = `You decide whether one pull request needs agent review before a human sees it.
Review it when the change does any of these:
- spans more than one module, service or datastore;
- changes a database schema or adds a migration;
- changes a published contract others depend on: an API, an event, a config key, a tool;
- touches auth, permissions, secrets, payments or crypto.
Otherwise it needs no review.

Reply with only this JSON object:
{"review": true|false, "reason": "one sentence naming what the change touches"}`

/** Reads Haiku's reply; throws when it is not the answer the prompt asked for. */
export const parseSurface = (text: string): Surface => {
  const v = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Surface
  if (typeof v.review !== 'boolean' || typeof v.reason !== 'string' || v.reason.trim() === '') throw new Error(`not a review decision: ${text.slice(0, 200)}`)
  return { review: v.review, reason: v.reason }
}

/** Decides from a PR's diff whether it is reviewed: always at or above `size` lines changed, otherwise as Haiku judges what it touches. */
export const surface = async (complete: Complete, diff: string, size: number): Promise<Surface> => {
  const lines = linesChanged(diff)
  if (lines >= size) return { review: true, reason: `${lines} lines changed, at or above the review size of ${size}` }
  const r = await complete({ model: 'haiku', system: SYSTEM, prompt: diff, effort: 'low', timeoutMs: 60_000 })
  if (!r.isAnswered) throw new Error(`no answer (${r.reason})`)
  return parseSurface(r.text)
}
