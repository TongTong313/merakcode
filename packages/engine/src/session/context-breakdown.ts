// Pure breakdown of context usage by source (no I/O).
//
// Counts the characters each source contributes to the input context of one LLM request. No tokenizer here:
// tokenizers differ per provider and Claude's is not public, so "share of characters × real total input tokens" is
// the best practical estimate (the total is exact, the shares are approximate).
// Must be collected in LLM.stream while the sources are still separate; boundaries are lost once they are joined.
export namespace ContextBreakdown {
  /** Raw material per source, collected while the sources are still separate */
  export interface Sources {
    /** Base system prompt as actually sent: agent.prompt or the provider prompt, plus user.system */
    systemBase: string
    /** Environment blocks (elements of SystemPrompt.environment) */
    environment: string[]
    /** Rule files such as AGENTS.md / CLAUDE.md (elements of InstructionPrompt.system) */
    rules: string[]
    /** Resolved tools: id → { description, JSON Schema } */
    tools: Record<string, { description?: string; schema: unknown }>
    /** Ids of the tools that come from MCP (reuses mcpIds from resolveTools to avoid querying MCP again) */
    mcpToolIds: ReadonlySet<string>
    /** Conversation history (ModelMessage[]), counted by serialized length */
    messages: unknown
  }

  /** Characters per source; total is their sum */
  export interface Result {
    systemBase: number
    environment: number
    rules: number
    toolDefinitions: number
    mcp: number
    skills: number
    subagents: number
    conversation: number
    total: number
  }

  /** Synthetic tools, not real context, so not counted: _noop shim, invalid repair slot, StructuredOutput */
  const SYNTHETIC = new Set(["_noop", "invalid", "StructuredOutput"])

  const joinLen = (a: string[]) => a.join("\n").length
  const toolLen = (key: string, t: { description?: string; schema: unknown }) =>
    (t.description?.length ?? 0) + JSON.stringify(t.schema).length + key.length

  export function compute(src: Sources): Result {
    let toolDefinitions = 0
    let mcp = 0
    let skills = 0
    let subagents = 0
    for (const [key, t] of Object.entries(src.tools)) {
      if (SYNTHETIC.has(key)) continue
      const n = toolLen(key, t)
      if (src.mcpToolIds.has(key)) mcp += n
      else if (key === "skill") skills += n
      else if (key === "subagent") subagents += n
      else toolDefinitions += n
    }
    const systemBase = src.systemBase.length
    const environment = joinLen(src.environment)
    const rules = joinLen(src.rules)
    // An empty conversation counts as 0 rather than 2 for "[]"; real requests have at least one user message.
    const conversation =
      Array.isArray(src.messages) && src.messages.length === 0 ? 0 : JSON.stringify(src.messages).length
    const total = systemBase + environment + rules + toolDefinitions + mcp + skills + subagents + conversation
    return { systemBase, environment, rules, toolDefinitions, mcp, skills, subagents, conversation, total }
  }
}
