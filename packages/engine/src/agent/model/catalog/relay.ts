import { Log } from "@merakcode/log/logger"
import { accept, parseItems, type CatalogModel, type Modality } from "./model"

const log = Log.create({ service: "catalog.relay" })

type Item = {
  id?: string
  limit?: { context?: number; output?: number }
  context_length?: number
  context_window?: number
  max_context_length?: number
  max_input_tokens?: number
  max_model_len?: number
  max_output_tokens?: number
  max_tokens?: number
  max_completion_tokens?: number
  endpoints?: string[]
  supported_endpoints?: string[]
  endpoint_types?: string[]
  vision?: boolean
  reasoning?: boolean
  tool_call?: boolean
  modalities?: { input?: string[] }
}

function first(values: Array<number | undefined>) {
  return values.find((value) => value !== undefined && value > 0)
}

export type RelayRow = CatalogModel & { endpoints?: string[] }

export function parse(item: unknown): RelayRow | undefined {
  const row = item as Item
  if (!row || typeof row.id !== "string" || !row.id) return undefined
  const input: Modality[] | undefined =
    row.vision === true || row.modalities?.input?.includes("image") ? ["text", "image"] : undefined
  const model = accept({
    id: row.id,
    name: row.id,
    context: first([
      row.limit?.context,
      row.context_length,
      row.context_window,
      row.max_context_length,
      row.max_input_tokens,
      row.max_model_len,
    ]),
    output: first([row.limit?.output, row.max_output_tokens, row.max_tokens, row.max_completion_tokens]),
    input,
    reasoning: row.reasoning,
    toolcall: row.tool_call,
  })
  if (!model) {
    log.warn("skipped relay model", { id: row.id })
    return undefined
  }
  const endpoints = [row.endpoints, row.supported_endpoints, row.endpoint_types].find((item) => item && item.length > 0)
  return endpoints ? { ...model, endpoints } : model
}

export function parseList(payload: unknown): RelayRow[] {
  const data = (payload as { data?: unknown[] } | undefined)?.data
  return Array.isArray(data) ? (parseItems(data, parse) as RelayRow[]) : []
}
