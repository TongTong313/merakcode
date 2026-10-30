import { Log } from "@merakcode/log/logger"
import { accept, type CatalogModel } from "./model"
import { bearer, getJSON, modelsURL } from "./http"

const log = Log.create({ service: "catalog.zhipu" })

/** The published OpenAPI has no model-list schema, so only the id is read. */
export function parse(item: unknown): CatalogModel | undefined {
  const row = item as { id?: string }
  if (!row || typeof row.id !== "string" || !row.id) return undefined
  const model = accept({ id: row.id, name: row.id })
  if (!model) log.warn("skipped zhipu model", { id: row.id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const body = (await getJSON(modelsURL(input.url), bearer(input.key))) as { data?: unknown[] }
  return body.data ?? []
}
