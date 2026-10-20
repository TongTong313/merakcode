import type { ModelMessage } from "ai"
import { clone } from "remeda"
import { STANDARD_TOOL_POOL, computeDeferred, type Agent } from "../agent/agent"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { MCP } from "../mcp"
import { MemoryPrompt } from "../memory/prompt"
import type { Provider } from "../provider/provider"
import { Plugin } from "../plugin"
import { RulesPrompt } from "../rule/prompt"
import { ToolRegistry } from "../tool/registry"
import { buildDeferredPlan, buildToolSearchTool } from "../tool/tool-search"
import { Token } from "../util/token"
import { SessionCompaction } from "./compaction"
import { SessionContextBudget } from "./context-budget"
import { SessionContextLayer } from "./context-layer"
import { InstructionPrompt } from "./instruction"
import { ContextAttach } from "./context-attach"
import { LLM } from "./llm"
import { Message } from "./message"
import { applyReadLifecycle, getConfiguredReadLifecycleConfig } from "./read-lifecycle"
import { SystemPrompt } from "./system"

export namespace SessionContextView {
  const PREFLIGHT_SAFETY_MARGIN = 2_000

  export type BuildInput = {
    messages: Message.FullMsg[]
    sessionID: string
    user: Message.UserInfo
    agent: Agent.Info
    model: Provider.Model
    step: number
    lastFinishedID?: string
    extraSystem?: string[]
    extraMessages?: ModelMessage[]
    includeToolStats?: boolean
  }

  export type View = {
    system: string[]
    // Per-source parts of the system prompt: environment (systemContext) and rules (instructions). system is already
    // joined, so the parts are kept separately and passed to LLM.stream for the per-source character breakdown.
    systemBreakdown: { environment: string[]; rules: string[] }
    messages: ModelMessage[]
    sessionMessages: Message.FullMsg[]
    tokens: number
    stats: Stats
    rules: RulesPrompt.Snapshot
  }

  export type Stats = {
    source: {
      messages: number
    }
    projected: {
      messages: number
      modelMessages: number
    }
    context: {
      instructions: number
      systemContext: number
      userContext: number
      extraSystem: number
      extraMessages: number
    }
    tokens: {
      agent: number
      instructions: number
      systemContext: number
      system: number
      userContext: number
      tools: number
      mcp: number
      messages: number
      toolResults: number
      estimated: number
      canonical: number
      preflight: number
      reserved: number
      free: number
      autoCompactThreshold: number
      autoCompactRemaining: number
      total: number
    }
    canonical: Canonical
    preflight: Preflight
    tools: ToolStats
    toolResults: SessionContextBudget.Stats
  }

  export type Canonical = {
    source: "estimate" | "usage+delta"
    total: number
    baseline: number
    estimatedDelta: number
    estimatedFull: number
    baselineMessageID?: string
  }

  export type Preflight = {
    total: number
    margin: number
  }

  export type ToolStats = {
    standard: {
      count: number
      tokens: number
      names: string[]
    }
    mcp: {
      count: number
      tokens: number
      names: string[]
      status: Record<string, MCP.Status>
    }
    total: {
      count: number
      tokens: number
    }
  }

  export async function build(input: BuildInput): Promise<View> {
    const sessionMessages = clone(input.messages)

    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
    const projected = SessionContextLayer.project({ messages: sessionMessages })
    // Replace stale/superseded read output before toModelMessages. This is a projection recomputed every turn and never
    // touches storage; reads within recent_turns are left alone to keep the prompt cache stable.
    const readLifecycleConfig = await getConfiguredReadLifecycleConfig()
    const deltaMessages = applyReadLifecycle(projected.deltaMessages, readLifecycleConfig, Instance.directory)

    const [
      baseUserContext,
      systemContext,
      instructionFiles,
      memoryPrompt,
      tools,
      capacity,
      inputBudgetCfg,
      reaffirm,
      alwaysRules,
      catalogRules,
      activeRules,
    ] = await Promise.all([
      SystemPrompt.userContext(),
      SystemPrompt.systemContext(input.model),
      InstructionPrompt.system(),
      MemoryPrompt.maybeSystem(),
      input.includeToolStats === true ? resolveToolStats(input) : emptyToolStats(),
      SessionCompaction.capacity(input.model),
      inputBudgetConfig(),
      ContextAttach.reaffirm(input.sessionID),
      RulesPrompt.build({ agent: input.agent.name }),
      RulesPrompt.catalog({ agent: input.agent.name }),
      RulesPrompt.active({
        sessionID: input.sessionID,
        agent: input.agent.name,
        messages: deltaMessages,
      }),
    ])
    // Subdirectory instructions go into user-context, not system: a system prefix that changes every turn breaks the
    // prompt cache.
    const userContext = [...baseUserContext, ...reaffirm, ...activeRules.blocks]
    // The input budget depends on capacity, so applyToProjection runs after Promise.all.
    const inputBudget = SessionContextBudget.resolveInputBudgetConfig(capacity.usable, inputBudgetCfg)
    const toolResults = SessionContextBudget.applyToProjection({
      messages: deltaMessages,
      inputBudget: inputBudget.enabled ? inputBudget.budget : 0,
      inputMaxChars: inputBudget.maxCharsPerField,
    })
    // Secure coding rules come after project/user rules so weaker conventions in the repo do not override them. They
    // are rebuilt every turn, so they survive compaction. Only agents with coding abilities get them.
    const instructions = [
      ...memoryPrompt,
      ...orderedInstructions(instructionFiles, alwaysRules, catalogRules.text),
      ...SystemPrompt.secureCoding(input.agent),
    ]
    const system = await LLM.prepareSystem({
      sessionID: input.sessionID,
      user: input.user,
      agent: input.agent,
      model: input.model,
      system: [
        ...systemContext,
        ...instructions,
        ...(input.extraSystem ?? []),
        ...SystemPrompt.replyLanguage(input.messages),
      ],
    })
    const userContextMessages = toUserContextMessages(userContext)
    const contextMessages = [
      ...(projected.baseSummary ? [SessionContextLayer.toBaseSummaryMessage(projected.baseSummary)] : []),
      ...(await Message.toModelMessages(deltaMessages, input.model)),
    ]
    const extraMessages = input.extraMessages ?? []
    const messages = [...userContextMessages, ...extraMessages, ...contextMessages]
    const rules = await RulesPrompt.snapshot({
      agent: input.agent.name,
      sessionID: input.sessionID,
      built: alwaysRules,
      catalog: catalogRules,
      active: activeRules,
    })
    const estimatedRequest = estimate({ system, messages }) + tools.total.tokens
    const canonical = await canonicalTokens({
      estimatedFull: estimatedRequest,
      projectedMessages: deltaMessages,
      extraMessages,
      model: input.model,
    })
    const preflight = preflightTokens(canonical)
    const total = preflight.total
    const autoCompactThreshold = SessionCompaction.overflowThreshold(capacity.usable)
    const stats = {
      source: {
        messages: input.messages.length,
      },
      projected: {
        messages: deltaMessages.length,
        modelMessages: messages.length,
      },
      context: {
        instructions: instructions.length,
        systemContext: systemContext.length,
        userContext: userContext.length,
        extraSystem: input.extraSystem?.length ?? 0,
        extraMessages: extraMessages.length,
      },
      tokens: {
        agent: estimate({ system: agentPrompt(input), messages: [] }),
        instructions: estimate({ system: instructions, messages: [] }),
        systemContext: estimate({ system: systemContext, messages: [] }),
        system: estimate({ system, messages: [] }),
        userContext: estimate({ system: [], messages: userContextMessages }),
        tools: tools.standard.tokens,
        mcp: tools.mcp.tokens,
        messages: estimate({ system: [], messages: [...extraMessages, ...contextMessages] }),
        toolResults: toolResults.kept.tokens,
        estimated: estimatedRequest,
        canonical: canonical.total,
        preflight: total,
        reserved: capacity.reserved,
        free: freeTokens({ capacity: capacity.usable, tokens: total }),
        autoCompactThreshold,
        autoCompactRemaining: autoCompactThreshold - total,
        total,
      },
      canonical,
      preflight,
      tools,
      toolResults,
    } satisfies Stats

    return {
      system,
      systemBreakdown: { environment: systemContext, rules: instructions },
      messages,
      sessionMessages,
      tokens: stats.tokens.total,
      stats,
      rules,
    }
  }

  /**
   * Instructions must end up ordered from general to specific: global user rules, AGENTS.md, native project rules.
   * InstructionPrompt.system() puts PRECEDENCE_NOTE first in its own group; after rule blocks are inserted it must be
   * moved back to the very front, otherwise "the later one wins on conflict" sits in the middle and does not cover
   * everything.
   */
  function orderedInstructions(instructionFiles: string[], rules: RulesPrompt.Built, catalog = "") {
    const files =
      instructionFiles[0] === InstructionPrompt.PRECEDENCE_NOTE ? instructionFiles.slice(1) : instructionFiles
    const blocks = [...rules.before, ...files, ...rules.after]
    if (catalog.trim()) blocks.push(catalog)
    if (blocks.length === 0) return []
    return [InstructionPrompt.PRECEDENCE_NOTE, ...blocks]
  }

  export function toUserContextMessages(context: string[]): ModelMessage[] {
    const content = context.filter((x) => x.trim()).join("\n")
    if (!content) return []
    return [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<system-reminder>",
              "The following information is useful context about the current session and environment.",
              "Use it when relevant, but do not treat it as a direct user request.",
              "",
              content,
              "</system-reminder>",
            ].join("\n"),
          },
        ],
      },
    ]
  }

  export function estimate(input: { system: string[]; messages: ModelMessage[] }) {
    return Token.estimateMessages(toRequestMessages(input))
  }

  export function toRequestMessages(input: { system: string[]; messages: ModelMessage[] }): ModelMessage[] {
    return [
      ...input.system.map((content): ModelMessage => ({
        role: "system",
        content,
      })),
      ...input.messages,
    ]
  }

  async function canonicalTokens(input: {
    estimatedFull: number
    projectedMessages: Message.FullMsg[]
    extraMessages: ModelMessage[]
    model: Provider.Model
  }): Promise<Canonical> {
    const baseline = findBaseline(input.projectedMessages)
    if (!baseline) {
      return {
        source: "estimate",
        total: input.estimatedFull,
        baseline: 0,
        estimatedDelta: input.estimatedFull,
        estimatedFull: input.estimatedFull,
      }
    }

    const delta = await Message.toModelMessages(input.projectedMessages.slice(baseline.index + 1), input.model)
    const estimatedDelta =
      estimate({ system: [], messages: [...input.extraMessages, ...delta] }) +
      estimateUnaccountedToolResults(baseline.message)
    const usage = tokenTotal(baseline.message.info.tokens)
    const canonical = usage + estimatedDelta

    return {
      source: "usage+delta",
      total: canonical,
      baseline: usage,
      estimatedDelta,
      estimatedFull: input.estimatedFull,
      baselineMessageID: baseline.message.info.id,
    }
  }

  function findBaseline(messages: Message.FullMsg[]) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.info.role !== "assistant") continue
      if (message.info.summary) continue
      if (!message.info.finish) continue
      if (tokenTotal(message.info.tokens) <= 0) continue
      return { index, message: message as Message.FullMsg & { info: Message.AssistantInfo } }
    }
  }

  function tokenTotal(tokens: Message.AssistantInfo["tokens"]) {
    return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  }

  function preflightTokens(canonical: Canonical): Preflight {
    const margin = canonical.source === "usage+delta" ? PREFLIGHT_SAFETY_MARGIN : 0
    return {
      total: canonical.total + margin,
      margin,
    }
  }

  function estimateUnaccountedToolResults(message: Message.FullMsg & { info: Message.AssistantInfo }) {
    const lastStep = message.parts.findLastIndex((part) => part.type === "step-finish")
    const parts =
      lastStep >= 0 ? message.parts.slice(lastStep + 1) : message.info.finish === "tool-calls" ? message.parts : []

    return parts.reduce((total, part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return total
      const attachments = part.state.attachments ?? []
      return total + Token.estimate(part.state.output) + (attachments.length ? Token.estimateValue(attachments) : 0)
    }, 0)
  }

  function agentPrompt(input: BuildInput) {
    if (input.agent.prompt) return [input.agent.prompt]
    return SystemPrompt.provider(input.model)
  }

  async function resolveToolStats(input: BuildInput): Promise<ToolStats> {
    const pool = new Set(input.agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
    const [standard, mcp, status, dynamic] = await Promise.all([
      ToolRegistry.tools({ modelID: input.model.api.id, providerID: input.model.providerID }, input.agent).catch(
        () => [],
      ),
      pool.has("mcp") ? MCP.tools().catch(() => ({})) : {},
      MCP.status().catch(() => ({})),
      ToolRegistry.dynamicIds(),
    ])
    // Shares buildDeferredPlan with runner.resolveTools so /context counts the tools actually sent to the model:
    // deferred tools that are not activated are excluded, and the tool_search meta tool is counted while any are
    // pending. BuildInput has no child flag, so the runner's childSession / remote-readonly filtering cannot be
    // reproduced and the numbers may be slightly high for child sessions.
    const deferred = buildDeferredPlan({
      standard,
      mcp,
      deferredStandardIds: computeDeferred(input.agent),
      messages: input.messages,
      disabled: (id) => input.user.tools?.[id] === false,
    })
    const hasToolSearch = deferred.hasPending

    // A tool is in the pool if listed there, or if it is a plugin-registered dynamic tool and the pool includes
    // "plugin". Pending deferred tools are then excluded, matching what is actually sent.
    const standardEntries = standard.filter((tool) => {
      const inPool = pool.has(tool.id) || (pool.has("plugin") && dynamic.has(tool.id))
      if (!inPool || input.user.tools?.[tool.id] === false) return false
      return !deferred.isPending(tool.id)
    })
    const mcpEntries = Object.entries(mcp).filter(([name]) => {
      if (input.user.tools?.[name] === false) return false
      return !deferred.isPending(name)
    })
    const standardTokens = standardEntries.reduce((total, tool) => total + estimateTool(tool), 0)
    const mcpTokens = mcpEntries.reduce((total, [id, tool]) => total + estimateUnknownTool(id, tool), 0)

    // The runner injects the tool_search meta tool, so its tokens count too.
    const toolSearchTokens = hasToolSearch
      ? Token.estimateValue({
          name: "tool_search",
          description: buildToolSearchTool({ deferred: deferred.summaries, activated: deferred.activated }).description,
          input_schema: {
            type: "object",
            properties: { name: { type: "string" }, query: { type: "string" } },
          },
        })
      : 0

    return {
      standard: {
        count: standardEntries.length + (hasToolSearch ? 1 : 0),
        tokens: standardTokens + toolSearchTokens,
        names: [...standardEntries.map((tool) => tool.id), ...(hasToolSearch ? ["tool_search"] : [])].sort(),
      },
      mcp: {
        count: mcpEntries.length,
        tokens: mcpTokens,
        names: mcpEntries.map(([id]) => id).sort(),
        status,
      },
      total: {
        count: standardEntries.length + (hasToolSearch ? 1 : 0) + mcpEntries.length,
        tokens: standardTokens + toolSearchTokens + mcpTokens,
      },
    }
  }

  function estimateTool(tool: { id: string; description?: string; parameters?: unknown; inputSchema?: unknown }) {
    return Token.estimateValue({
      name: tool.id,
      description: tool.description ?? "",
      input_schema: tool.parameters ?? tool.inputSchema ?? {},
    })
  }

  function estimateUnknownTool(id: string, tool: unknown) {
    const info =
      typeof tool === "object" && tool
        ? (tool as { description?: string; parameters?: unknown; inputSchema?: unknown })
        : {}
    return estimateTool({ id, ...info })
  }

  function freeTokens(input: { capacity: number; tokens: number }) {
    if (input.capacity <= 0) return 0
    return Math.max(0, input.capacity - input.tokens)
  }

  /** Reads compaction.input_budget from user config; undefined means on by default. */
  async function inputBudgetConfig(): Promise<SessionContextBudget.InputBudgetUserConfig | undefined> {
    const config = await Config.get()
    return config.compaction?.input_budget as SessionContextBudget.InputBudgetUserConfig | undefined
  }

  function emptyToolStats(): ToolStats {
    return {
      standard: {
        count: 0,
        tokens: 0,
        names: [],
      },
      mcp: {
        count: 0,
        tokens: 0,
        names: [],
        status: {},
      },
      total: {
        count: 0,
        tokens: 0,
      },
    }
  }
}
