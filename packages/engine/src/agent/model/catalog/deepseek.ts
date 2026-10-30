import { Log } from "@merakcode/log/logger"
import { accept, modalities, positive, type CatalogModel } from "./model"
import { bearer, getJSON, modelsURL } from "./http"

const log = Log.create({ service: "catalog.deepseek" })

type Item = {
  id?: string
  name?: string
  context_window?: number
  max_output_tokens?: number
  input_modalities?: string[]
  output_modalities?: string[]
  effort?: { supported_levels?: string[]; default_level?: string }
}

/** One DeepSeek list row. An effort object means the model reasons and can be turned off. */
export function parse(item: unknown): CatalogModel | undefined {
  const row = item as Item
  if (!row || typeof row.id !== "string" || !row.id) {
    log.warn("skipped deepseek model", { reason: "missing id" })
    return undefined
  }
  const efforts = row.effort?.supported_levels?.filter((level) => level && level !== "none")
  const model = accept({
    id: row.id,
    name: row.name || row.id,
    context: positive(row.context_window),
    output: positive(row.max_output_tokens),
    input: modalities(row.input_modalities),
    outputModalities: modalities(row.output_modalities),
    reasoning: !!row.effort,
    efforts: efforts?.length ? efforts : undefined,
    canDisable: row.effort ? true : undefined,
    defaultEffort: row.effort?.default_level,
  })
  if (!model) log.warn("skipped deepseek model", { id: row.id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const body = (await getJSON(modelsURL(input.url), bearer(input.key))) as { data?: unknown[] }
  return body.data ?? []
}
