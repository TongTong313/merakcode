import { Log } from "@merakcode/log/logger"
import { accept, modalities, positive, type CatalogModel } from "./model"
import { bearer, getJSON, modelsURL } from "./http"

const log = Log.create({ service: "catalog.openrouter" })

type Prices = { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string }

/** A conditional price. Absent price keys inherit the base price. */
type Override = Prices & { min_prompt_tokens?: number; utc_start?: number; utc_end?: number; utc_days?: string[] }

type Item = {
  id?: string
  name?: string
  context_length?: number
  created?: number
  expiration_date?: string | null
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  top_provider?: { max_completion_tokens?: number }
  supported_parameters?: string[]
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] | null; default_effort?: string | null } | null
  pricing?: Prices & { overrides?: Override[] }
}

/** Per-token dollars, per the API reference, become per-million dollars. */
function perMillion(value: string | undefined) {
  if (value === undefined || value === "") return undefined
  const amount = Number(value)
  return Number.isFinite(amount) ? Number((amount * 1_000_000).toPrecision(12)) : undefined
}

type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number }

function price(row: Prices, base?: Price): Price | undefined {
  const input = perMillion(row.prompt) ?? base?.input
  const output = perMillion(row.completion) ?? base?.output
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cacheRead: perMillion(row.input_cache_read) ?? base?.cacheRead,
    cacheWrite: perMillion(row.input_cache_write) ?? base?.cacheWrite,
  }
}

/** Only long-context overrides apply to every request; time-window prices are left out. */
function tiers(overrides: Override[] | undefined, base: Price) {
  const result = (overrides ?? []).flatMap((row) => {
    if (row.utc_start !== undefined || row.utc_end !== undefined || row.utc_days !== undefined) return []
    if (typeof row.min_prompt_tokens !== "number") return []
    const tier = price(row, base)
    return tier ? [{ ...tier, above: row.min_prompt_tokens }] : []
  })
  return result.length ? result.sort((a, b) => a.above - b.above) : undefined
}

export function parse(item: unknown): CatalogModel | undefined {
  const row = item as Item
  if (!row || typeof row.id !== "string" || !row.id) return undefined
  if (row.id.endsWith(":batch") || row.id.startsWith("~")) return undefined
  const reasoning = row.reasoning
  const listed =
    reasoning && Object.hasOwn(reasoning, "supported_efforts") ? (reasoning.supported_efforts ?? []) : undefined
  const efforts = listed?.filter((level) => level && level !== "none")
  const parameters = row.supported_parameters
  const base = row.pricing ? price(row.pricing) : undefined
  const model = accept({
    id: row.id,
    name: row.name || row.id,
    context: positive(row.context_length),
    output: positive(row.top_provider?.max_completion_tokens),
    input: modalities(row.architecture?.input_modalities),
    outputModalities: modalities(row.architecture?.output_modalities),
    reasoning: reasoning ? true : undefined,
    toolcall: parameters ? parameters.includes("tools") : undefined,
    temperature: parameters ? parameters.includes("temperature") : undefined,
    efforts: efforts?.length ? efforts : undefined,
    canDisable: reasoning?.mandatory === true ? false : listed?.includes("none") ? true : undefined,
    defaultEffort:
      reasoning?.default_effort && reasoning.default_effort !== "none" ? reasoning.default_effort : undefined,
    releaseDate: row.created ? new Date(row.created * 1000).toISOString().slice(0, 10) : undefined,
    status: row.expiration_date ? "deprecated" : undefined,
    cost: base ? { currency: "USD" as const, ...base, tiers: tiers(row.pricing?.overrides, base) } : undefined,
  })
  if (!model) log.warn("skipped openrouter model", { id: row.id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const headers = input.key ? bearer(input.key) : {}
  const body = (await getJSON(modelsURL(input.url), headers)) as { data?: unknown[] }
  return body.data ?? []
}
