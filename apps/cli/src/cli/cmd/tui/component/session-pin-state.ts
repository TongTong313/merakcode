/** Removes duplicate pinned IDs, keeping first-seen order. */
export function dedupePinned(ids: string[]) {
  return [...new Set(ids)]
}

/** Toggles the pinned state of a session; newly pinned sessions are appended. */
export function togglePinnedIds(pinnedIds: string[], sessionID: string) {
  const exists = pinnedIds.includes(sessionID)
  const next = exists ? pinnedIds.filter((id) => id !== sessionID) : [...pinnedIds, sessionID]
  return dedupePinned(next)
}

/** Parses the `pinned` field from session.json. */
export function parsePinnedFromFile(data: unknown) {
  if (!data || typeof data !== "object") return []
  const pinned = (data as Record<string, unknown>).pinned
  if (!Array.isArray(pinned)) return []
  return dedupePinned(pinned.filter((item): item is string => typeof item === "string"))
}

/** Removes a deleted session from the pinned list. */
export function removePinnedId(pinnedIds: string[], sessionID: string) {
  if (!pinnedIds.includes(sessionID)) return pinnedIds
  return pinnedIds.filter((id) => id !== sessionID)
}
