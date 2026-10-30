import { Log } from "@merakcode/log/logger"
import { accept, type CatalogModel } from "./model"
import { bearer, getJSON, modelsURL } from "./http"
import { normalizeModelID } from "./match"

const log = Log.create({ service: "catalog.openai" })
const SKIP = /embedding|tts|whisper|dall-e|image|moderation|transcribe|realtime|audio/i

type Item = { id?: string; created?: number; shutdown_date?: string | null }

export function parse(item: unknown, publicIDs?: ReadonlySet<string>): CatalogModel | undefined {
  const row = item as Item
  if (!row || typeof row.id !== "string" || !row.id) return undefined
  const known = publicIDs?.has(normalizeModelID(row.id))
  if (!known && SKIP.test(row.id)) return undefined
  const model = accept({
    id: row.id,
    name: row.id,
    releaseDate: row.created ? new Date(row.created * 1000).toISOString().slice(0, 10) : undefined,
    status: row.shutdown_date ? "deprecated" : undefined,
  })
  if (!model) log.warn("skipped openai model", { id: row.id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const body = (await getJSON(modelsURL(input.url), bearer(input.key))) as { data?: unknown[] }
  return body.data ?? []
}
