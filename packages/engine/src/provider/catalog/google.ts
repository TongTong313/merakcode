import { Log } from "@merakcode/log/logger"
import { accept, positive, type CatalogModel } from "./model"
import { getJSON, modelsURL } from "./http"

const log = Log.create({ service: "catalog.google" })

type Item = {
  name?: string
  displayName?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: string[]
  thinking?: boolean
  temperature?: number
}

export function parse(item: unknown): CatalogModel | undefined {
  const row = item as Item
  if (!row?.name) return undefined
  const methods = row.supportedGenerationMethods ?? []
  if (methods.length && !methods.includes("generateContent")) return undefined
  const id = row.name.replace(/^models\//, "")
  const model = accept({
    id,
    name: row.displayName || id,
    context: positive(row.inputTokenLimit),
    output: positive(row.outputTokenLimit),
    reasoning: row.thinking,
    temperature: row.temperature === undefined ? undefined : true,
  })
  if (!model) log.warn("skipped google model", { id })
  return model
}

export async function fetch(input: { url: string; key: string }): Promise<unknown[]> {
  const collected: unknown[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL(modelsURL(input.url))
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const body = (await getJSON(url.toString(), { "x-goog-api-key": input.key })) as {
      models?: unknown[]
      nextPageToken?: string
    }
    const rows = body.models ?? []
    collected.push(...rows)
    pageToken = body.nextPageToken
    if (!pageToken || rows.length === 0) break
  }
  return collected
}
