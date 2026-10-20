// Model visibility logic with no framework dependencies.
// The source of truth is ui.models.hidden in the global config (a list of "providerID/modelID").
// Shared by the desktop app and the web UI so both behave the same.

export type Visibility = "show" | "hide"
export type ModelKey = { providerID: string; modelID: string }

/** Backend key form: providerID/modelID */
export function backendKey(m: ModelKey): string {
  return `${m.providerID}/${m.modelID}`
}

/** Parses backend keys into ModelKeys, dropping invalid entries */
export function parseModelKeys(keys: string[] | undefined): ModelKey[] {
  if (!keys) return []
  return keys
    .map((k) => {
      const [providerID, modelID] = k.split("/")
      return providerID && modelID ? { providerID, modelID } : undefined
    })
    .filter((x): x is ModelKey => !!x)
}

/** Whether the model is in the hidden list */
export function isHidden(hidden: string[] | undefined, model: ModelKey): boolean {
  return (hidden ?? []).includes(backendKey(model))
}

/** Toggles visibility and returns the new hidden list in the config schema shape */
export function toggleHidden(hidden: string[] | undefined, model: ModelKey, visible: boolean): string[] {
  const key = backendKey(model)
  const next = new Set(hidden ?? [])
  if (visible) next.delete(key)
  else next.add(key)
  return [...next]
}
