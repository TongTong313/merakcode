import { Log } from "@merakcode/log/logger"
import { accept, positive, type CatalogModel, type Modality } from "./model"
import { bearer, getJSON, modelsURL } from "./http"

const log = Log.create({ service: "catalog.moonshot" })

type Item = {
  id?: string
  created?: number
  context_length?: number
  supports_image_in?: boolean
  supports_video_in?: boolean
  supports_reasoning?: boolean
}

export function parse(item: unknown): CatalogModel | undefined {
  const row = item as Item
  if (!row || typeof row.id !== "string" || !row.id) return undefined
  const input: Modality[] = ["text"]
  if (row.supports_image_in) input.push("image")
  if (row.supports_video_in) input.push("video")
  const model = accept({
    id: row.id,
    name: row.id,
    context: positive(row.context_length),
    input,
    outputModalities: ["text"],
    reasoning: row.supports_reasoning,
    releaseDate: row.created ? new Date(row.created * 1000).toISOString().slice(0, 10) : undefined,
  })
  if (!model) log.warn("skipped moonshot model", { id: row.id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const body = (await getJSON(modelsURL(input.url), bearer(input.key))) as { data?: unknown[] }
  return body.data ?? []
}
