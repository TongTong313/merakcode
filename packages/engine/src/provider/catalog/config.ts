import { modalities, type CatalogModel } from "./model"

type ConfigModel = {
  id?: string
  name?: string
  family?: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  interleaved?: true | { field: "reasoning_content" | "reasoning_details" }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  status?: "alpha" | "beta" | "deprecated" | "active"
  headers?: Record<string, string>
  options?: Record<string, unknown>
  provider?: { npm?: string; api?: string }
}

/** Config fields the user actually wrote. Absent fields stay absent so the catalog can fill them. */
export function fromConfig(id: string, model: ConfigModel): Partial<CatalogModel> & { id: string } {
  const result: Partial<CatalogModel> & { id: string } = { id }
  if (model.name) result.name = model.name
  if (model.reasoning !== undefined) result.reasoning = model.reasoning
  if (model.temperature !== undefined) result.temperature = model.temperature
  if (model.tool_call !== undefined) result.toolcall = model.tool_call
  if (model.release_date) result.releaseDate = model.release_date
  if (model.status) result.status = model.status
  if (model.limit?.context !== undefined) result.context = model.limit.context
  if (model.limit?.output !== undefined) result.output = model.limit.output
  const input = modalities(model.modalities?.input)
  const output = modalities(model.modalities?.output)
  if (input) result.input = input
  if (output) result.outputModalities = output
  if (model.cost && (model.cost.input !== undefined || model.cost.output !== undefined)) {
    result.cost = {
      currency: "USD",
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      cacheRead: model.cost.cache_read,
      cacheWrite: model.cost.cache_write,
    }
  }
  return result
}

export type ConfigExtras = {
  apiID?: string
  npm?: string
  url?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  family?: string
  interleaved?: false | { field: "reasoning_content" | "reasoning_details" }
}

export function extras(id: string, model: ConfigModel, provider?: { npm?: string; api?: string }): ConfigExtras {
  return {
    apiID: model.id ?? id,
    npm: model.provider?.npm ?? provider?.npm,
    url: model.provider?.api ?? provider?.api,
    headers: model.headers,
    options: model.options,
    family: model.family,
    interleaved: model.interleaved === true ? { field: "reasoning_content" } : model.interleaved,
  }
}
