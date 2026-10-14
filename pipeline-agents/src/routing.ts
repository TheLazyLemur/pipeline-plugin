/** The difficulty at and above which a ticket is reviewed, from routing.md's `Review threshold: <n>` line. */
export const reviewFrom = (routing: string): number => {
  const line = routing.match(/^review threshold:(.*)$/im)
  // a routing.md written before the threshold existed gets the default, so no re-setup is needed
  if (line === null) return 3
  const n = Number((line[1] ?? '').trim())
  if (!Number.isInteger(n) || n < 1) throw new Error(`routing.md "Review threshold:" must be a whole number from 1, not ${JSON.stringify(line[1]?.trim())}`)
  return n
}
