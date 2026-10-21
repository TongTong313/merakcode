import z from "zod"
import { ModelsDev } from "./models"

function first(values: Array<number | undefined>) {
  return values.find((value) => value !== undefined)
}

function modelsURL(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/, "")
  const root = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
  return `${root}/models`
}

function protocol(id: string, endpoints: string[] | undefined): Relay.Endpoint {
  const station = endpoints?.find(
    (item) => item === "anthropic" || item === "openai" || item === "openai-response" || item === "openai-responses",
  )
  if (station === "anthropic") return "anthropic"
  if (station === "openai-response" || station === "openai-responses") return "openai-responses"
  if (station === "openai") return "openai-chat"
  const name = id.toLowerCase()
  if (name.includes("claude")) return "anthropic"
  if (name.includes("gpt") || name.includes("codex")) return "openai-responses"
  return "openai-chat"
}

export namespace Relay {
  const Item = z.object({
    id: z.string().min(1),
    limit: z
      .object({
        context: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
    context_length: z.number().optional(),
    context_window: z.number().optional(),
    max_context_length: z.number().optional(),
    max_input_tokens: z.number().optional(),
    max_model_len: z.number().optional(),
    max_output_tokens: z.number().optional(),
    max_tokens: z.number().optional(),
    max_completion_tokens: z.number().optional(),
    endpoints: z.array(z.string()).optional(),
    supported_endpoints: z.array(z.string()).optional(),
    endpoint_types: z.array(z.string()).optional(),
    vision: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    modalities: z.object({ input: z.array(z.string()).optional() }).optional(),
  })

  export type Endpoint = "anthropic" | "openai-responses" | "openai-chat"

  export type ListedModel = {
    id: string
    context?: number
    output?: number
    contextFrom?: "relay" | "catalog" | "fallback"
    outputFrom?: "relay" | "catalog" | "fallback"
    endpoints?: string[]
    endpoint?: Endpoint
    image?: boolean
    reasoning?: boolean
    toolcall?: boolean
  }

  /** Reads the model list a relay returned. Present limits keep the station's numbers. */
  export function readList(payload: unknown): ListedModel[] {
    const data = z.object({ data: z.array(z.unknown()) }).safeParse(payload)
    if (!data.success) return []
    return data.data.data.flatMap((item) => {
      const parsed = Item.safeParse(item)
      if (!parsed.success) return []
      const row = parsed.data
      const model: ListedModel = { id: row.id }
      const context = first([
        row.limit?.context,
        row.context_length,
        row.context_window,
        row.max_context_length,
        row.max_input_tokens,
        row.max_model_len,
      ])
      const output = first([row.limit?.output, row.max_output_tokens, row.max_tokens, row.max_completion_tokens])
      if (context !== undefined) {
        model.context = context
        model.contextFrom = "relay"
      }
      if (output !== undefined) {
        model.output = output
        model.outputFrom = "relay"
      }
      const endpoints = [row.endpoints, row.supported_endpoints, row.endpoint_types].find(
        (item) => item && item.length > 0,
      )
      if (endpoints) model.endpoints = endpoints
      if (typeof row.vision === "boolean") model.image = row.vision
      else if (row.modalities?.input?.includes("image")) model.image = true
      if (typeof row.reasoning === "boolean") model.reasoning = row.reasoning
      if (typeof row.tool_call === "boolean") model.toolcall = row.tool_call
      return [model]
    })
  }

  export type CatalogModel = {
    context?: number
    output?: number
    image?: boolean
    reasoning?: boolean
    toolcall?: boolean
  }

  /** Fills limits the station left out from a catalog entry with the same id. */
  export function resolve(input: { drafts: ListedModel[]; catalog: Record<string, CatalogModel> }): ListedModel[] {
    return input.drafts.map((draft) => {
      const known = input.catalog[draft.id] ?? input.catalog[draft.id.slice(draft.id.indexOf("/") + 1)]
      const model = { ...draft }
      if (model.context === undefined && known?.context !== undefined) {
        model.context = known.context
        model.contextFrom = "catalog"
      }
      if (model.output === undefined && known?.output !== undefined) {
        model.output = known.output
        model.outputFrom = "catalog"
      }
      if (model.image === undefined && known?.image !== undefined) model.image = known.image
      if (model.reasoning === undefined && known?.reasoning !== undefined) model.reasoning = known.reasoning
      if (model.toolcall === undefined && known?.toolcall !== undefined) model.toolcall = known.toolcall
      const claude = draft.id.toLowerCase().includes("claude")
      const limits = claude ? { context: 200_000, output: 64_000 } : { context: 128_000, output: 16_000 }
      if (model.context === undefined) {
        model.context = limits.context
        model.contextFrom = "fallback"
      }
      if (model.output === undefined) {
        model.output = limits.output
        model.outputFrom = "fallback"
      }
      if (model.image === undefined) model.image = claude
      if (model.reasoning === undefined) model.reasoning = claude
      if (model.toolcall === undefined) model.toolcall = true
      model.endpoint = protocol(draft.id, draft.endpoints)
      return model
    })
  }

  export const Kind = z.enum(["claude-code", "codex", "standard", "custom"])
  export type Kind = z.infer<typeof Kind>

  /** Beta flags a Claude Code client sends. Relays that sell a Claude Code group look for the first one. */
  export const CLAUDE_CODE_BETA =
    "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"

  /** Identity string those relays look for. Later layers append their own user agent after it. */
  export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.0"

  const DiscoverInput = z.object({
    baseURL: z.string().min(1),
    key: z.string().min(1),
    kind: Kind,
  })

  async function shippedCatalog() {
    const providers = await ModelsDev.get()
    const catalog: Record<string, CatalogModel> = {}
    for (const provider of Object.values(providers)) {
      for (const model of Object.values(provider.models)) {
        if (catalog[model.id]) continue
        const entry: CatalogModel = {}
        if (model.limit.context > 0) entry.context = model.limit.context
        if (model.limit.output > 0) entry.output = model.limit.output
        entry.image = model.modalities?.input?.includes("image") ?? false
        entry.reasoning = model.reasoning
        entry.toolcall = model.tool_call
        catalog[model.id] = entry
      }
    }
    return catalog
  }

  /** Fetches the station's model list. The key is sent only on this request and is not stored. */
  export async function discover(
    input: z.input<typeof DiscoverInput>,
  ): Promise<{ models: ListedModel[] } | { error: string }> {
    const parsed = DiscoverInput.safeParse(input)
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid relay" }
    try {
      const response = await fetch(modelsURL(parsed.data.baseURL), {
        headers: { authorization: `Bearer ${parsed.data.key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return { error: `station returned ${response.status}` }
      return { models: resolve({ drafts: readList(await response.json()), catalog: await shippedCatalog() }) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
