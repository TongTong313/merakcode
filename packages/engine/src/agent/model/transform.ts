import { mergeDeep, unique } from "remeda"
import type { JSONSchema7, LanguageModelV4FilePart, LanguageModelV4Prompt } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import { Flag } from "../../infra/flag/flag"

type Modality = "text" | "audio" | "image" | "video" | "pdf"

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

/** Prompt sent to the provider (params.prompt as seen in the transformParams middleware) */
type Prompt = LanguageModelV4Prompt
type PromptMessage = Prompt[number]

export namespace ProviderTransform {
  export const OUTPUT_TOKEN_MAX = Flag.MERAKCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // Maps npm package to the key the AI SDK expects for providerOptions
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/openai":
        return "openai"
      case "@ai-sdk/anthropic":
        return "anthropic"
      case "@ai-sdk/google":
        return "google"
      case "@openrouter/ai-sdk-provider":
        return "openrouter"
    }
    return undefined
  }

  /** Rewrites the toolCallId of tool calls and tool results in assistant and tool messages */
  function mapToolCallIds(msg: PromptMessage, map: (id: string) => string): PromptMessage {
    if (msg.role === "assistant") {
      return {
        ...msg,
        content: msg.content.map((part) =>
          part.type === "tool-call" || part.type === "tool-result"
            ? { ...part, toolCallId: map(part.toolCallId) }
            : part,
        ),
      }
    }
    if (msg.role === "tool") {
      return {
        ...msg,
        content: msg.content.map((part) =>
          part.type === "tool-result" ? { ...part, toolCallId: map(part.toolCallId) } : part,
        ),
      }
    }
    return msg
  }

  function normalizeMessages(msgs: Prompt, model: Provider.Model, options: Record<string, unknown>): Prompt {
    // Anthropic rejects empty content: drop empty system prompts and empty text/reasoning parts, and drop messages
    // left with no parts
    if (model.api.npm === "@ai-sdk/anthropic") {
      msgs = msgs.flatMap((msg): Prompt => {
        if (msg.role === "system") return msg.content === "" ? [] : [msg]
        const content = msg.content.filter(
          (part) => !((part.type === "text" || part.type === "reasoning") && part.text === ""),
        )
        return content.length === 0 ? [] : [{ ...msg, content } as PromptMessage]
      })
    }

    if (model.api.id.includes("claude")) {
      return msgs.map((msg) => mapToolCallIds(msg, (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_")))
    }
    if (
      model.providerID === "mistral" ||
      model.api.id.toLowerCase().includes("mistral") ||
      model.api.id.toLocaleLowerCase().includes("devstral")
    ) {
      const result: Prompt = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        // Mistral requires alphanumeric tool call IDs with exactly 9 characters
        result.push(
          mapToolCallIds(msg, (id) =>
            id
              .replace(/[^a-zA-Z0-9]/g, "")
              .substring(0, 9)
              .padEnd(9, "0"),
          ),
        )

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // reasoning_details expects provider-specific structured blocks, not plain text.
          if (field === "reasoning_details") {
            return {
              ...msg,
              content: filteredContent,
            }
          }

          // Include reasoning_content directly on the message for all assistant messages
          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  [field]: reasoningText,
                },
              },
            }
          }

          return {
            ...msg,
            content: filteredContent,
          }
        }

        return msg
      })
    }

    return msgs
  }

  function cacheMarker(model: Provider.Model) {
    if (model.api.npm === "@ai-sdk/openai-compatible") {
      return {
        key: "openaiCompatible",
        options: {
          openaiCompatible: {
            cache_control: { type: "ephemeral" },
          },
        },
      }
    }

    const isClaudeLike =
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic"
    if (!isClaudeLike) return undefined

    switch (sdkKey(model.api.npm) ?? model.providerID) {
      case "anthropic":
        return {
          key: "anthropic",
          options: {
            anthropic: {
              cacheControl: { type: "ephemeral" },
            },
          },
        }
      case "openrouter":
        return {
          key: "openrouter",
          options: {
            openrouter: {
              cacheControl: { type: "ephemeral" },
            },
          },
        }
    }
  }

  function applyCaching(msgs: Prompt, model: Provider.Model): Prompt {
    const marker = cacheMarker(model)
    if (!marker) return msgs

    const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
    const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

    for (const msg of unique([...system, ...final])) {
      const useMessageLevelOptions = marker.key === "anthropic" || msg.role === "assistant"
      const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && typeof lastContent === "object") {
          lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, marker.options)
          continue
        }
      }

      msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, marker.options)
    }

    return msgs
  }

  /** A file with empty inline data (nothing after data:...;base64, or zero bytes) */
  function emptyFile(data: LanguageModelV4FilePart["data"]) {
    if (data.type !== "data") return false
    if (typeof data.data !== "string") return data.data.length === 0
    const comma = data.data.indexOf(",")
    return data.data === "" || (data.data.startsWith("data:") && comma === data.data.length - 1)
  }

  function unsupportedParts(msgs: Prompt, model: Provider.Model): Prompt {
    return msgs.map((msg) => {
      if (msg.role !== "user") return msg
      const content = msg.content.map((part) => {
        if (part.type !== "file") return part
        const modality = mimeToModality(part.mediaType)
        if (modality === "image" && emptyFile(part.data)) {
          return {
            type: "text" as const,
            text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
          }
        }
        if (!modality || model.capabilities.input[modality]) return part
        const name = part.filename ? `"${part.filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })
      return { ...msg, content }
    })
  }

  export function message(msgs: Prompt, model: Provider.Model, options: Record<string, unknown>) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model, options)
    msgs = applyCaching(msgs, model)

    // Remap providerOptions keys from stored providerID to expected SDK key
    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID) {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts
        if (!(model.providerID in opts)) return opts
        const result = { ...opts }
        result[key] = result[model.providerID]
        delete result[model.providerID]
        return result
      }

      msgs = msgs.map((msg) => {
        if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
        return {
          ...msg,
          providerOptions: remap(msg.providerOptions),
          content: msg.content.map((part) => ({ ...part, providerOptions: remap(part.providerOptions) })),
        } as typeof msg
      })
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5
      if (id.includes("thinking") || id.includes("k2.") || id.includes("k2p")) {
        return 1.0
      }
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (id.includes("minimax-m2") || id.includes("kimi-k2.5") || id.includes("kimi-k2p5") || id.includes("gemini")) {
      return 0.95
    }
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (id.includes("m2.1")) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

  export type EffortSpec = { efforts?: string[]; canDisable?: boolean; defaultEffort?: string }

  function effortRank(value: string) {
    const index = EFFORT_RANK.indexOf(value)
    return index === -1 ? EFFORT_RANK.length : index
  }

  /** Menu keys: off first when thinking can be disabled, then the efforts the endpoint accepts. */
  function effortMenu(reasoning: boolean, spec: EffortSpec): string[] {
    if (!reasoning) return []
    const levels = [...(spec.efforts ?? [])].filter((item) => item !== "none" && item !== "off")
    levels.sort((a, b) => effortRank(a) - effortRank(b))
    if (levels.length === 0) return spec.canDisable === false ? [] : ["off", "on"]
    return spec.canDisable ? ["off", ...levels] : levels
  }

  /** Official default when it is on the menu, otherwise high, otherwise the higher-middle effort. Never off. */
  export function pickDefault(menu: string[], preferred: string | undefined) {
    if (menu.length === 0) return undefined
    if (preferred && preferred !== "off" && preferred !== "none" && menu.includes(preferred)) return preferred
    if (menu.includes("high")) return "high"
    const levels = menu.filter((item) => item !== "off" && item !== "on")
    if (levels.length === 0) return menu.includes("on") ? "on" : undefined
    return levels[Math.floor(levels.length / 2)]
  }

  function encodeEffort(model: Provider.Model, key: string): Record<string, any> {
    const npm = model.api.npm
    const providerID = model.providerID
    const id = model.api.id.toLowerCase()
    const google = npm === "@ai-sdk/google" || providerID === "google"
    const openai = npm === "@ai-sdk/openai" || providerID === "openai"
    const openrouter = npm === "@openrouter/ai-sdk-provider" || providerID === "openrouter"
    const anthropic = npm === "@ai-sdk/anthropic"
    const native = providerID === "deepseek" || providerID === "zhipuai" || providerID === "moonshotai-cn"
    if (key === "off") {
      if (anthropic || native) return { thinking: { type: "disabled" } }
      if (providerID === "alibaba-cn") return { enable_thinking: false }
      if (openai) return { reasoningEffort: "none", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
      if (openrouter) return { reasoning: { effort: "none" } }
      if (google && id.includes("2.5")) return { thinkingConfig: { includeThoughts: true, thinkingBudget: 0 } }
      if (google) return { thinkingConfig: { includeThoughts: true, thinkingLevel: "none" } }
      return { reasoningEffort: "none" }
    }
    if (key === "on") {
      if (anthropic) return { thinking: { type: "enabled" } }
      if (providerID === "alibaba-cn") return { enable_thinking: true }
      if (native) return { thinking: { type: "enabled" } }
      if (google && id.includes("2.5")) return { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } }
      if (google) return { thinkingConfig: { includeThoughts: true } }
      if (openrouter) return { reasoning: { enabled: true } }
      return {}
    }
    if (anthropic) return { effort: key }
    if (openai) return { reasoningEffort: key, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
    if (google) return { thinkingConfig: { includeThoughts: true, thinkingLevel: key } }
    if (openrouter) return { reasoning: { effort: key } }
    if (providerID === "alibaba-cn") return { reasoningEffort: key, enable_thinking: true }
    return { reasoningEffort: key }
  }

  /** Writes variants and defaultVariant from the merged effort fields. Plugins call this too. */
  export function fillVariants(model: Provider.Model, spec: EffortSpec) {
    const menu = effortMenu(model.capabilities.reasoning, spec)
    model.variants = Object.fromEntries(menu.map((key) => [key, encodeEffort(model, key)]))
    model.defaultVariant = pickDefault(menu, spec.defaultEffort)
  }

  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    const result: Record<string, any> = {}

    // openai and providers using openai package should set store to false by default.
    if (input.model.providerID === "openai" || input.model.api.npm === "@ai-sdk/openai") {
      result["store"] = false
    }

    if (input.model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
    }

    if (input.model.providerID === "zhipuai" && input.model.api.npm === "@ai-sdk/openai-compatible") {
      result["thinking"] = {
        type: "enabled",
        clear_thinking: false,
      }
    }

    const shouldSetPromptCacheKey = input.model.providerID === "openai" || input.providerOptions?.setCacheKey === true
    if (shouldSetPromptCacheKey) {
      result["promptCacheKey"] = input.sessionID
    }
    const promptCacheRetention = input.providerOptions?.promptCacheRetention
    if (
      input.model.api.npm === "@ai-sdk/openai" &&
      (promptCacheRetention === "in_memory" || promptCacheRetention === "24h")
    ) {
      result["promptCacheRetention"] = promptCacheRetention
    }

    if (input.model.api.npm === "@ai-sdk/google") {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
    }

    // Enable thinking by default for kimi-k2.5/k2p5 models using anthropic SDK
    const modelId = input.model.api.id.toLowerCase()
    if (
      input.model.api.npm === "@ai-sdk/anthropic" &&
      (modelId.includes("k2p5") || modelId.includes("kimi-k2.5") || modelId.includes("kimi-k2p5"))
    ) {
      result["thinking"] = {
        type: "enabled",
        budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
      }
    }

    // Enable thinking for reasoning models on alibaba-cn (DashScope).
    // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
    // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
    // deepseek-r1, etc. never output thinking/reasoning tokens.
    // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
    if (
      input.model.providerID === "alibaba-cn" &&
      input.model.capabilities.reasoning &&
      input.model.api.npm === "@ai-sdk/openai-compatible" &&
      !modelId.includes("kimi-k2-thinking")
    ) {
      result["enable_thinking"] = true
    }

    if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
      // Only set textVerbosity for non-chat gpt-5.x models
      // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
      if (
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        !input.model.api.id.includes("-chat")
      ) {
        result["textVerbosity"] = "low"
      }
    }

    return result
  }

  export function smallOptions(model: Provider.Model) {
    if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
      if (model.api.id.includes("gpt-5")) {
        if (model.api.id.includes("5.")) {
          return { store: false, reasoningEffort: "low" }
        }
        return { store: false, reasoningEffort: "minimal" }
      }
      return { store: false }
    }
    if (model.providerID === "google") {
      // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    if (model.providerID === "openrouter") {
      if (model.api.id.includes("google")) {
        return { reasoning: { enabled: false } }
      }
      return { reasoningEffort: "minimal" }
    }
    return {}
  }

  export function completionOptions(model: Provider.Model) {
    const base = smallOptions(model)
    if (model.providerID === "zhipuai") {
      return { ...base, thinking: { type: "disabled" } }
    }
    if (model.providerID === "alibaba-cn") {
      return { ...base, enable_thinking: false }
    }
    if (model.providerID === "moonshotai-cn") {
      return { ...base, thinking: { type: "disabled" } }
    }
    return base
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const key = sdkKey(model.api.npm) ?? model.providerID
    return { [key]: options }
  }

  /**
   * Tokens requested for one reply. Compaction reserves this same amount from the context window.
   * A blank limit falls back to 32_000 so the request never sends 0. When the output limit fills
   * the window, reserve at most 32_000: a shared 262_144 window would otherwise leave no room to
   * talk, while a smaller window keeps its own limit instead of being raised to 32_000.
   */
  export function maxOutputTokens(model: Provider.Model): number {
    const context = model.limit.context
    const stated = model.limit.output > 0 ? model.limit.output : 32_000
    const requested = context > 0 && stated >= context ? Math.min(stated, 32_000) : stated
    const ceiling = Flag.MERAKCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX
    return ceiling ? Math.min(requested, ceiling) : requested
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array") {
          if (result.items == null) {
            result.items = {}
          }
          // Ensure items has at least a type if it's an empty object
          // This handles nested arrays like { type: "array", items: { type: "array", items: {} } }
          if (typeof result.items === "object" && !Array.isArray(result.items) && !result.items.type) {
            result.items.type = "string"
          }
        }

        // Remove properties/required from non-object types (Gemini rejects these)
        if (result.type && result.type !== "object") {
          delete result.properties
          delete result.required
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema as JSONSchema7
  }
}
