/** Each agent prompt file's name in `agents/` and its mtime. */
export type Prompts = Record<string, number>

/**
 * The line to log when an agent prompt file was changed, added or removed since session start; null when none was.
 * A running session keeps the agent definitions it loaded at start, while a reload only swaps in the code.
 */
export const promptsChanged = (atStart: Prompts, now: Prompts): string | null => {
  const changed = [...new Set([...Object.keys(atStart), ...Object.keys(now)])].filter(name => atStart[name] !== now[name]).sort()
  return changed.length ? `agent prompts changed (${changed.map(name => `agents/${name}`).join(', ')}); restart the session to apply them` : null
}
