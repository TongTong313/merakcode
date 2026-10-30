import type { CatalogModel } from "./model"
import type { FallbackEntry } from "./fallback"

/** Last path segment, lowercased, with "." and "_" rewritten to "-". */
export function normalizeModelID(id: string) {
  const last = id.split("/").pop() ?? id
  return last.toLowerCase().replace(/[._]/g, "-")
}

const PUBLIC_PREFIX: Record<string, string> = {
  anthropic: "anthropic/",
  openai: "openai/",
  google: "google/",
  deepseek: "deepseek/",
  "moonshotai-cn": "moonshotai/",
  zhipuai: "z-ai/",
  "alibaba-cn": "qwen/",
}

/** Public-catalog row for the same model. Prefers the provider's own id prefix when several rows share a name. */
export function matchPublic(models: readonly CatalogModel[], providerID: string, id: string) {
  const want = normalizeModelID(id)
  const hits = models.filter((model) => normalizeModelID(model.id) === want)
  const prefix = PUBLIC_PREFIX[providerID]
  if (prefix) {
    const prefixed = hits.find((model) => model.id.toLowerCase().startsWith(prefix))
    if (prefixed) return prefixed
  }
  return hits[0]
}

/** Longest family prefix for this provider. */
export function matchFallback(entries: readonly FallbackEntry[], providerID: string, id: string) {
  const name = normalizeModelID(id)
  const hits = entries.filter((entry) => entry.provider === providerID && name.startsWith(entry.family))
  hits.sort((a, b) => b.family.length - a.family.length)
  return hits[0]
}
