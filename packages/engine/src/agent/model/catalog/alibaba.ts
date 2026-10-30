import { Log } from "@merakcode/log/logger"
import { accept, modalities, positive, type CatalogModel } from "./model"
import { bearer, getJSON } from "./http"

const log = Log.create({ service: "catalog.alibaba" })

type PriceItem = { type?: string; price?: number | string; price_unit?: string; time_band?: string | null }
type PriceGroup = { range_name?: string; prices?: PriceItem[] }

type Item = {
  model?: string
  name?: string
  capabilities?: string[]
  features?: string[]
  published_time?: string
  inference_metadata?: { request_modality?: string[]; response_modality?: string[] }
  inference_offline_info?: unknown
  model_info?: { context_window?: number; max_output_tokens?: number }
  prices?: PriceGroup[]
}

const RANGE = /^(?:(\d+)([km])<)?输入<=(\d+)([km])$/

function tokens(amount: string, unit: string) {
  return Number(amount) * (unit === "m" ? 1_000_000 : 1_000)
}

/** Per-million-token prices of one range. Peak, off-peak and per-call or per-second items are left out. */
function amounts(group: PriceGroup) {
  const result: Record<string, number> = {}
  for (const item of group.prices ?? []) {
    if (item.time_band && item.time_band !== "standard") continue
    if (item.price_unit !== "每百万tokens" || !item.type) continue
    const amount = Number(item.price)
    if (Number.isFinite(amount)) result[item.type] = amount
  }
  return result
}

function price(values: Record<string, number>, prefix = "") {
  const input = values[`${prefix}input_token`]
  const output = values[`${prefix}output_token`]
  if (input === undefined || output === undefined) return undefined
  return {
    input,
    output,
    cacheRead: values[`${prefix}input_token_cache`] ?? values[`${prefix}input_token_cache_read`],
    cacheWrite: values[`${prefix}input_token_cache_creation_5m`],
  }
}

/** The lowest range is the base price and the others become tiers. An unreadable range name drops the price. */
function cost(groups: PriceGroup[] | undefined): CatalogModel["cost"] {
  const ranges: Array<{ above: number; upper: number; values: Record<string, number> }> = []
  for (const group of groups ?? []) {
    const values = amounts(group)
    const name = group.range_name ?? "Default"
    if (name === "Default") {
      ranges.push({ above: 0, upper: Infinity, values })
      continue
    }
    const match = RANGE.exec(name)
    if (!match) return undefined
    ranges.push({ above: match[1] ? tokens(match[1], match[2]!) : 0, upper: tokens(match[3]!, match[4]!), values })
  }
  ranges.sort((a, b) => a.upper - b.upper)
  const [lowest, ...rest] = ranges
  const base = lowest && price(lowest.values)
  if (!base) return undefined
  const tiers = rest.flatMap((range) => {
    const tier = price(range.values)
    return tier ? [{ ...tier, above: range.above, thinking: price(range.values, "thinking_") }] : []
  })
  return {
    currency: "CNY",
    ...base,
    tiers: tiers.length ? tiers : undefined,
    thinking: price(lowest.values, "thinking_"),
  }
}

function chat(row: Item) {
  const response = row.inference_metadata?.response_modality ?? []
  return !!row.capabilities?.includes("TG") && response.some((item) => item.toLowerCase() === "text")
}

export function parse(item: unknown): CatalogModel | undefined {
  const row = item as Item
  if (!row || typeof row.model !== "string" || !row.model) return undefined
  if (!chat(row)) return undefined
  const model = accept({
    id: row.model,
    name: row.name || row.model,
    context: positive(row.model_info?.context_window),
    output: positive(row.model_info?.max_output_tokens),
    input: modalities(row.inference_metadata?.request_modality),
    outputModalities: modalities(row.inference_metadata?.response_modality),
    reasoning: row.capabilities?.includes("Reasoning"),
    toolcall: row.features ? row.features.includes("function-calling") : undefined,
    releaseDate: row.published_time?.slice(0, 10),
    status: row.inference_offline_info ? "deprecated" : undefined,
    cost: cost(row.prices),
  })
  if (!model) log.warn("skipped bailian model", { id: row.model })
  return model
}

function rows(body: unknown): unknown[] {
  const models = (body as { output?: { models?: unknown[] } } | undefined)?.output?.models
  return Array.isArray(models) ? models : []
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const origin = new URL(input.url).origin
  const collected: unknown[] = []
  for (let page = 1; page <= 20; page++) {
    const url = new URL("/api/v1/models", origin)
    url.searchParams.set("page_no", String(page))
    url.searchParams.set("page_size", "100")
    const pageRows = rows(await getJSON(url.toString(), bearer(input.key)))
    collected.push(...pageRows)
    if (pageRows.length < 100) break
  }
  return collected
}
