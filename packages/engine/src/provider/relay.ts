import z from "zod"
import { Auth } from "../auth"
import { OFFICIAL_PROVIDER_IDS } from "./official"
import * as Catalog from "./catalog"

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

function hostOf(id: string) {
  const name = id.toLowerCase()
  if (name.includes("claude")) return "anthropic"
  if (name.includes("gpt") || name.includes("codex")) return "openai"
  if (name.includes("gemini")) return "google"
  if (name.includes("qwen")) return "alibaba-cn"
  if (name.includes("glm")) return "zhipuai"
  if (name.includes("kimi") || name.includes("moonshot")) return "moonshotai-cn"
  if (name.includes("deepseek")) return "deepseek"
  return undefined
}

export namespace Relay {
  export type Endpoint = "anthropic" | "openai-responses" | "openai-chat"
  export const Source = z.enum(["relay", "catalog", "fallback"])

  /** A relay model in the shared catalog shape, plus where each window came from and the protocol to use. */
  export const Listed = Catalog.Model.extend({
    contextFrom: Source.optional(),
    outputFrom: Source.optional(),
    endpoint: z.enum(["anthropic", "openai-responses", "openai-chat"]).optional(),
  })
  export type Listed = z.infer<typeof Listed>

  type Draft = Listed & { endpoints?: string[] }

  /** Reads the model list a relay returned. Present limits keep the station's numbers. */
  export function readList(payload: unknown): Draft[] {
    return Catalog.parseRelay(payload).map((row) => ({
      ...row,
      contextFrom: row.context === undefined ? undefined : "relay",
      outputFrom: row.output === undefined ? undefined : "relay",
    }))
  }

  /** Fills fields the station left out. Missing windows stay missing when no catalog or fallback entry has them. */
  export function resolve(input: { drafts: Draft[]; catalog: Record<string, Partial<Catalog.Model>> }): Listed[] {
    return input.drafts.map(({ endpoints, ...draft }) => {
      const known =
        input.catalog[draft.id] ??
        input.catalog[Catalog.normalizeModelID(draft.id)] ??
        input.catalog[draft.id.slice(draft.id.indexOf("/") + 1)]
      const host = hostOf(draft.id)
      const fallback = host ? Catalog.fallbackFor(host, draft.id) : undefined
      const window = (key: "context" | "output") => {
        if (draft[key] !== undefined) return { value: draft[key], from: draft[`${key}From`] }
        if (known?.[key] !== undefined) return { value: known[key], from: "catalog" as const }
        if (fallback?.[key] !== undefined) return { value: fallback[key], from: "fallback" as const }
        return { value: undefined, from: undefined }
      }
      const context = window("context")
      const output = window("output")
      return {
        ...draft,
        context: context.value,
        contextFrom: context.from,
        output: output.value,
        outputFrom: output.from,
        input: draft.input ?? known?.input,
        reasoning: draft.reasoning ?? known?.reasoning,
        toolcall: draft.toolcall ?? known?.toolcall,
        endpoint: protocol(draft.id, endpoints),
      }
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

  /** The public catalog, overlaid with official lists of connected providers, keyed by id and normalized id. */
  async function shippedCatalog() {
    const catalog: Record<string, Catalog.Model> = {}
    const put = (model: Catalog.Model) => {
      catalog[model.id] = model
      catalog[Catalog.normalizeModelID(model.id)] ??= model
    }
    for (const model of await Catalog.readPublic()) put(model)
    for (const id of OFFICIAL_PROVIDER_IDS) {
      if ((await Auth.get(id))?.type !== "api") continue
      for (const model of await Catalog.read(id)) put(model)
    }
    return catalog
  }

  /** Fetches the station's model list. The key is sent only on this request and is not stored. */
  export async function discover(
    input: z.input<typeof DiscoverInput>,
  ): Promise<{ models: Listed[] } | { error: string }> {
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
