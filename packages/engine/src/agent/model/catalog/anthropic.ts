import { Log } from "@merakcode/log/logger"
import { accept, positive, type CatalogModel, type Modality } from "./model"
import { getJSON } from "./http"

const log = Log.create({ service: "catalog.anthropic" })
const ORDER = ["low", "medium", "high", "xhigh", "max"]

type Supported = { supported?: boolean } | null
type Item = {
  id?: string
  display_name?: string
  created_at?: string
  max_input_tokens?: number | null
  max_tokens?: number | null
  lifecycle?: string
  capabilities?: {
    image_input?: Supported
    pdf_input?: Supported
    thinking?: { supported?: boolean; types?: { disabled?: Supported } }
    effort?: Record<string, Supported | boolean | undefined>
  } | null
}

export function parse(item: unknown): CatalogModel | undefined {
  const row = item as Item
  if (!row || typeof row.id !== "string" || !row.id) return undefined
  const capabilities = row.capabilities
  const effort = capabilities?.effort
  const efforts = effort ? ORDER.filter((level) => (effort[level] as Supported)?.supported) : undefined
  const input: Modality[] = ["text"]
  if (capabilities?.image_input?.supported) input.push("image")
  if (capabilities?.pdf_input?.supported) input.push("pdf")
  const thinking = capabilities?.thinking
  const model = accept({
    id: row.id,
    name: row.display_name || row.id,
    context: positive(row.max_input_tokens),
    output: positive(row.max_tokens),
    input,
    outputModalities: ["text"],
    reasoning: thinking?.supported === true || !!efforts?.length,
    efforts,
    canDisable: thinking?.types?.disabled?.supported,
    releaseDate: row.created_at?.slice(0, 10),
    status: row.lifecycle === "deprecated" ? "deprecated" : undefined,
  })
  if (!model) log.warn("skipped anthropic model", { id: row.id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const origin = new URL(input.url).origin
  const headers = { "x-api-key": input.key, "anthropic-version": "2023-06-01" }
  const collected: unknown[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL("/v1/models", origin)
    url.searchParams.set("limit", "1000")
    if (after) url.searchParams.set("after_id", after)
    const body = (await getJSON(url.toString(), headers)) as { data?: unknown[]; has_more?: boolean; last_id?: string }
    const rows = body.data ?? []
    collected.push(...rows)
    if (!body.has_more || rows.length === 0 || !body.last_id) break
    after = body.last_id
  }
  return collected
}
