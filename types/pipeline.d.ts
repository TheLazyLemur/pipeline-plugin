declare module 'claude-code' {
  interface PluginState {
    pipeline: {
      /** Each agent prompt file in agents/ and its mtime, as this session loaded them; kept here to outlive a reload. */
      agentPrompts: Record<string, number>
    }
  }
}
