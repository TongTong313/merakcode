import { sortBy } from "remeda"

/** Splits "provider/model" into providerID and modelID; the model name may contain further slashes */
export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return { providerID: providerID!, modelID: rest.join("/") }
}

/** Default model preferences (later entries win), matched by id substring: each vendor's main coding model */
const priority = ["z.ai/glm-5", "moonshotai/kimi-k2.5-thinking", "z.ai/glm-5.1", "claude-sonnet-4", "gemini-3-pro"]
/**
 * Matched by exact id and ranked above the preferences: stable vendor-maintained aliases that always point to the
 * current main version. Dated snapshots on Bailian get retired and new models are not enabled on every account, so
 * picking them on first use often fails with "model not found".
 */
const aliases = ["qwen-plus"]

type Sortable = { id: string; status?: string; release_date?: string; capabilities?: { toolcall?: boolean } }

/**
 * Sort order for picking a default model. A coding agent needs tool calls, so models without them (intent detection,
 * speech, embeddings, etc.) go last and deprecated ones next; otherwise stable aliases, then preferences, then
 * release date from newest to oldest. Shared by the engine and clients such as ACP.
 */
export function sortModels<T extends Sortable>(models: readonly T[]): T[] {
  return sortBy(
    models,
    [(model) => (model.capabilities?.toolcall === false ? 1 : 0), "asc"],
    [(model) => (model.status === "deprecated" ? 1 : 0), "asc"],
    [(model) => aliases.indexOf(model.id), "desc"],
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.release_date ?? "", "desc"],
    [(model) => model.id, "desc"],
  )
}
