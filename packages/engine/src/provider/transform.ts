import { mergeDeep, unique } from "remeda"
import type { JSONSchema7, LanguageModelV4FilePart, LanguageModelV4Prompt } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { encodeVariantsFromReasoning, isNativeThinkingProvider } from "./reasoning"
import { iife } from "../util/iife"
import { Flag } from "../flag/flag"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

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
      case "@ai-sdk/azure":
        return "openai"
      case "@ai-sdk/amazon-bedrock":
        return "bedrock"
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic"
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return "google"
      case "@ai-sdk/gateway":
        return "gateway"
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
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/google-vertex/anthropic"
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
      case "bedrock":
        return {
          key: "bedrock",
          options: {
            bedrock: {
              cachePoint: { type: "default" },
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
      const useMessageLevelOptions = marker.key === "anthropic" || marker.key === "bedrock" || msg.role === "assistant"
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
    if (key && key !== model.providerID && model.api.npm !== "@ai-sdk/azure") {
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

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    // Variants from model metadata (e.g. the off toggle shipped in private-models.json) apply as is, skipping the
    // capabilities check and the legacy denylist so custom providers keep their thinking toggle.
    if (model.variants && Object.keys(model.variants).length > 0) {
      return model.variants
    }
    if (!model.capabilities.reasoning) return {}
    // Chinese thinking providers (DashScope / Zhipu / Moonshot) ignore the legacy reasoningEffort, so they are fully
    // data driven ({} means nothing to tune) and never fall back to a fake legacy effort.
    if (isNativeThinkingProvider(model)) {
      return encodeVariantsFromReasoning(model) as Record<string, Record<string, any>>
    }
    // Others: non-empty legacy variants of verified providers are returned unchanged. Only when legacy is empty
    // (denylisted or not covered) and models.dev has reasoning_options are variants derived from data.
    const legacy = legacyVariants(model)
    if (Object.keys(legacy).length > 0) return legacy
    if (model.reasoning_options?.length)
      return encodeVariantsFromReasoning(model) as Record<string, Record<string, any>>
    return legacy
  }

  function legacyVariants(model: Provider.Model): Record<string, Record<string, any>> {
    const id = model.id.toLowerCase()
    if (
      id.includes("deepseek") ||
      id.includes("minimax") ||
      id.includes("glm") ||
      id.includes("mistral") ||
      id.includes("kimi") ||
      // TODO: Remove this after models.dev data is fixed to use "kimi-k2.5" instead of "k2p5"
      id.includes("k2p5")
    )
      return {}

    // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
    if (id.includes("grok") && id.includes("grok-3-mini")) {
      if (model.api.npm === "@openrouter/ai-sdk-provider") {
        return {
          low: { reasoning: { effort: "low" } },
          high: { reasoning: { effort: "high" } },
        }
      }
      return {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      }
    }
    if (id.includes("grok")) return {}

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        if (!model.id.includes("gpt") && !model.id.includes("gemini-3")) return {}
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))

      // TODO: YOU CANNOT SET max_tokens if this is set!!!
      case "@ai-sdk/gateway":
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/cerebras":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
      case "@ai-sdk/togetherai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
      case "@ai-sdk/xai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
      case "@ai-sdk/deepinfra":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
      case "venice-ai-sdk-provider":
      // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
      case "@ai-sdk/openai-compatible":
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/azure":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
        if (id === "o1-mini") return {}
        const azureEfforts = ["low", "medium", "high"]
        if (id.includes("gpt-5-") || id === "gpt-5") {
          azureEfforts.unshift("minimal")
        }
        return Object.fromEntries(
          azureEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )
      case "@ai-sdk/openai":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
        if (id === "gpt-5-pro") return {}
        const openaiEfforts = iife(() => {
          if (id.includes("codex")) {
            if (id.includes("5.2") || id.includes("5.3")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
            return WIDELY_SUPPORTED_EFFORTS
          }
          const arr = [...WIDELY_SUPPORTED_EFFORTS]
          if (id.includes("gpt-5-") || id === "gpt-5") {
            arr.unshift("minimal")
          }
          if (model.release_date >= "2025-11-13") {
            arr.unshift("none")
          }
          if (model.release_date >= "2025-12-04") {
            arr.push("xhigh")
          }
          return arr
        })
        return Object.fromEntries(
          openaiEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      case "@ai-sdk/google-vertex/anthropic":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider

        if (model.api.id.includes("opus-4-6") || model.api.id.includes("opus-4.6")) {
          const efforts = ["low", "medium", "high", "max"]
          return Object.fromEntries(
            efforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }

        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(31_999, model.limit.output - 1),
            },
          },
        }

      case "@ai-sdk/amazon-bedrock":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
        if (model.api.id.includes("opus-4-6") || model.api.id.includes("opus-4.6")) {
          const efforts = ["low", "medium", "high", "max"]
          return Object.fromEntries(
            efforts.map((effort) => [
              effort,
              {
                reasoningConfig: {
                  type: "adaptive",
                  maxReasoningEffort: effort,
                },
              },
            ]),
          )
        }
        // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
        if (model.api.id.includes("anthropic")) {
          return {
            high: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }

        // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "enabled",
                maxReasoningEffort: effort,
              },
            },
          ]),
        )

      case "@ai-sdk/google-vertex":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
      case "@ai-sdk/google":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )

      case "@ai-sdk/mistral":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
        return {}

      case "@ai-sdk/cohere":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
        return {}

      case "@ai-sdk/groq":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
        const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
        return Object.fromEntries(
          groqEffort.map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )

      case "@ai-sdk/perplexity":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
        return {}

      case "@mymediset/sap-ai-provider":
      case "@jerome-benoit/sap-ai-provider-v2":
        if (model.api.id.includes("anthropic")) {
          return {
            high: {
              thinking: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              thinking: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
    }
    return {}
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
      if (input.model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (input.model.providerID === "baseten") {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (["zai", "zhipuai"].includes(input.model.providerID) && input.model.api.npm === "@ai-sdk/openai-compatible") {
      result["thinking"] = {
        type: "enabled",
        clear_thinking: false,
      }
    }

    const shouldSetPromptCacheKey =
      input.model.providerID === "openai" ||
      input.model.api.npm === "@ai-sdk/openai" ||
      input.providerOptions?.setCacheKey === true
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

    if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    // Enable thinking by default for kimi-k2.5/k2p5 models using anthropic SDK
    const modelId = input.model.api.id.toLowerCase()
    if (
      (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
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
      if (!input.model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
        result["reasoningSummary"] = "auto"
      }

      // Only set textVerbosity for non-chat gpt-5.x models
      // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
      if (
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        !input.model.api.id.includes("-chat") &&
        input.model.providerID !== "azure"
      ) {
        result["textVerbosity"] = "low"
      }
    }

    if (input.model.providerID === "venice") {
      result["promptCacheKey"] = input.sessionID
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
    if (["zhipuai", "zai"].includes(model.providerID)) {
      return { ...base, thinking: { type: "disabled" } }
    }
    if (model.providerID === "alibaba-cn") {
      return { ...base, enable_thinking: false }
    }
    if (model.providerID === "moonshotai-cn" || model.providerID === "moonshotai") {
      return { ...base, thinking: { type: "disabled" } }
    }
    return base
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const key = sdkKey(model.api.npm) ?? model.providerID
    return { [key]: options }
  }

  export function maxOutputTokens(model: Provider.Model): number {
    return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

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
