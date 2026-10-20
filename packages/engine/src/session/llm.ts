import { Installation } from "../installation"
import { Provider } from "../provider/provider"
import { Log } from "@merakcode/log/logger"
import {
  streamText,
  wrapLanguageModel,
  extractReasoningMiddleware,
  type ModelMessage,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
  asSchema,
} from "ai"
import { clone, mergeDeep, pipe } from "remeda"
import { ContextBreakdown } from "./context-breakdown"
import { ProviderTransform } from "../provider/transform"
import { type Agent, STANDARD_TOOL_POOL } from "../agent/agent"
import type { Message } from "./message"
import { Plugin } from "../plugin"
import { SystemPrompt } from "./system"
import { Auth } from "../auth"
import { MCP } from "../mcp"
import { ToolRegistry } from "../tool/registry"
import { randomUUID } from "node:crypto"
import { failure } from "@merakcode/log"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  /** Stream events that carry model output, used to time the first chunk */
  const CONTENT_CHUNKS = new Set(["text-delta", "reasoning-delta", "tool-input-start", "tool-call", "source", "file"])

  export type StreamInput = {
    user: Message.UserInfo
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    systemPrepared?: boolean
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
    // Raw environment and rules text for the context breakdown. They are separate in the runner but cannot be split
    // again after joining into system, so they are passed explicitly.
    systemBreakdown?: { environment: string[]; rules: string[] }
    // MCP.tools() keys already fetched by the caller (SessionRunner.resolveTools), reused to avoid another
    // listTools() round trip in the same request; fetched here when absent.
    mcpToolIds?: Set<string>
    // Plugin dynamic tool ids already fetched by the caller (ToolRegistry.dynamicIds()); fetched here when absent.
    dynamicToolIds?: Set<string>
  }

  export type StreamOutput = ReturnType<typeof streamText<ToolSet>>

  export type PrepareSystemInput = {
    user: Message.UserInfo
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    provider?: Provider.Info
    auth?: Auth.Info
  }

  export async function prepareSystem(input: PrepareSystemInput) {
    const header = (input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model))
      .filter((x) => x)
      .join("\n")
    const rest = [...input.system, ...(input.user.system ? [input.user.system] : [])].filter((x) => x).join("\n")
    const system = [header, rest].filter((x) => x)

    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    if (system.length === 0) {
      system.push(...original)
    }
    // Keep a stable cacheable header and collapse any plugin-added tail into the second system block.
    if (header && system.length > 2 && system[0] === header) {
      const tail = system.slice(1)
      system.length = 0
      system.push(header, tail.join("\n"))
    }
    return system
  }

  export async function stream(input: StreamInput) {
    const started = Date.now()
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.id)
      .tag("mode", input.agent.mode)
      .tag("messageID", input.user.id)
      .tag("requestID", randomUUID())
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
      messageCount: input.messages.length,
      toolCount: Object.keys(input.tools).length,
    })
    let stage = "preparation"
    try {
      const [language, provider, auth] = await Promise.all([
        Provider.getLanguage(input.model),
        Provider.getProvider(input.model.providerID),
        Auth.get(input.model.providerID),
      ])
      l.info("auth check", {
        providerID: input.model.providerID,
        hasAuth: !!auth,
        authType: auth?.type,
        hasCredential: auth?.type === "api" ? !!auth.key : !!auth,
      })
      // The provider may be missing (disconnected but still referenced by the session). Throw a descriptive error
      // instead of a TypeError from accessing provider.options below.
      if (!provider) {
        throw new Provider.ModelNotFoundError({ providerID: input.model.providerID, modelID: input.model.id })
      }
      const system = input.systemPrepared ? clone(input.system) : await prepareSystem({ ...input, provider, auth })

      const variant =
        !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: provider.options,
          })
      const options: Record<string, any> = pipe(
        base,
        mergeDeep(input.model.options),
        mergeDeep(input.agent.options),
        mergeDeep(variant),
      )

      const params = await Plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          provider,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          // Same shape as opencode's chat.params output: plugins may change the limit (undefined = provider default)
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      const { headers } = await Plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          provider,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      const maxOutputTokens = params.maxOutputTokens

      const { tools, mcpIds } = await resolveTools(input)

      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        provider.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
        tools["_noop"] = tool({
          description:
            "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      // Context breakdown by source, measured in characters once system and tools are resolved but sources are still
      // separable. systemBase mirrors the base system prompt actually sent (agent.prompt or provider prompt, plus
      // user.system); environment and rules from input.system are counted separately via systemBreakdown.
      const schemaJson = (s: unknown) => {
        try {
          return asSchema(s as any).jsonSchema
        } catch {
          return {}
        }
      }
      const contextBreakdown = ContextBreakdown.compute({
        systemBase: [
          ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
        environment: input.systemBreakdown?.environment ?? [],
        rules: input.systemBreakdown?.rules ?? [],
        tools: Object.fromEntries(
          Object.entries(tools).map(([k, t]) => [
            k,
            { description: typeof t.description === "string" ? t.description : "", schema: schemaJson(t.inputSchema) },
          ]),
        ),
        mcpToolIds: mcpIds,
        messages: input.messages,
      })

      stage = "model-stream"
      let first = true
      const result = streamText({
        onChunk({ chunk }) {
          // Count only model output; lifecycle events such as start arrive before the request is sent
          if (!first || !CONTENT_CHUNKS.has(chunk.type)) return
          first = false
          l.info("stream first chunk", { duration: Date.now() - started })
        },
        onAbort() {
          l.info("stream cancelled", { duration: Date.now() - started, category: "cancelled" })
        },
        onError(error) {
          l.error("stream error", {
            ...failure(error.error, input.abort.aborted),
            duration: Date.now() - started,
            stage,
          })
        },
        async experimental_repairToolCall(failed) {
          const lower = failed.toolCall.toolName.toLowerCase()
          if (lower !== failed.toolCall.toolName && tools[lower]) {
            l.info("repairing tool call", {
              tool: failed.toolCall.toolName,
              repaired: lower,
            })
            return {
              ...failed.toolCall,
              toolName: lower,
            }
          }
          // Arguments are not valid JSON (unclosed objects, unescaped strings, output cut off by the length limit).
          // Do not return the raw AI SDK error: it repeats the whole broken JSON while only the trailing
          // "Expected '}'" is useful, and the model tends to retry unchanged. Return one actionable instruction,
          // worded like the zod validation error in Tool.define, and log the raw error.
          l.warn("tool call arguments are not valid JSON", {
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          })
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error:
                "arguments are not valid JSON. Re-issue the tool call with complete, well-formed JSON " +
                "(close every object/array, escape quotes inside strings). " +
                "If the payload is large, split it into several smaller calls.",
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, params.options),
        activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
        tools,
        toolChoice: input.toolChoice,
        maxOutputTokens,
        abortSignal: input.abort,
        headers: {
          ...(input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `merakcode/${Installation.VERSION}`,
              }
            : undefined),
          ...input.model.headers,
          ...headers,
        },
        maxRetries: input.retries ?? 0,
        // Each system prompt block is a separate system message: middleware adds cache markers per block, and the first
        // block stays stable to hit the cache
        instructions: system.map((content) => ({ role: "system" as const, content })),
        messages: input.messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              async transformParams(args) {
                if (args.type === "stream") {
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                }
                return args.params
              },
            },
            // Some providers put reasoning in content as inline <think>...</think>, which would render as body text.
            // This middleware only rewrites the text channel, re-emitting <think> content as reasoning. Native
            // reasoning_content passes through unchanged, so models that already use the reasoning field do not get a
            // second reasoning block. Enabled only for reasoning models, with startWithReasoning:false so a literal
            // <think> in a normal answer is not swallowed.
            ...(input.model.capabilities.reasoning
              ? [extractReasoningMiddleware({ tagName: "think", startWithReasoning: false })]
              : []),
          ],
        }),
      })
      void Promise.resolve(result.finalStep)
        .then((step) => {
          l.info("stream completed", {
            duration: Date.now() - started,
            finishReason: step.finishReason,
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
            totalTokens: step.usage.totalTokens,
            providerRequestID: step.response.headers?.["x-request-id"] ?? step.response.headers?.["request-id"],
          })
        })
        .catch((error) => {
          l.warn("stream completion unavailable", {
            duration: Date.now() - started,
            ...failure(error, input.abort.aborted),
          })
        })
      // Attach the breakdown to the stream result without affecting consumption; the processor reads and persists it
      // on the first start event
      return Object.assign(result, { contextBreakdown })
    } catch (error) {
      l.error("stream setup failed", { stage, duration: Date.now() - started, ...failure(error, input.abort.aborted) })
      throw error
    }
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user" | "mcpToolIds" | "dynamicToolIds">) {
    const pool = new Set(input.agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
    const allowMcp = pool.has("mcp")
    const allowPlugin = pool.has("plugin")
    // Reuse sets already fetched by the caller (see StreamInput.mcpToolIds/dynamicToolIds); otherwise fetch them in
    // parallel. Skip a fetch when allowMcp/allowPlugin is false, since those tools would be filtered out below anyway.
    const [mcpIds, dynamic] = await Promise.all([
      input.mcpToolIds ??
        (allowMcp ? MCP.tools().then((m) => new Set(Object.keys(m))) : Promise.resolve(new Set<string>())),
      input.dynamicToolIds ?? (allowPlugin ? ToolRegistry.dynamicIds() : Promise.resolve(new Set<string>())),
    ])

    for (const tool of Object.keys(input.tools)) {
      if (tool === "invalid") continue
      if (tool === "StructuredOutput") continue

      if (input.user.tools?.[tool] === false) {
        delete input.tools[tool]
        continue
      }

      if (mcpIds.has(tool)) {
        if (!allowMcp) delete input.tools[tool]
        continue
      }

      if (!pool.has(tool) && !(pool.has("plugin") && dynamic.has(tool))) {
        delete input.tools[tool]
      }
    }
    // mcpIds is returned so the context breakdown can tell which tools come from MCP without fetching again
    return { tools: input.tools, mcpIds }
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
