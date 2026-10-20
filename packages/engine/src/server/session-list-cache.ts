/**
 * Short-lived cache of the global session list, so consecutive searches do not read every session again.
 * After the TTL expires or invalidate() is called, the next get() loads again.
 */
export function createSessionListCache<T>(input: { ttlMs: number; load: () => Promise<T> }) {
  let entry: { at: number; value: T } | undefined

  return {
    async get() {
      const now = Date.now()
      if (entry && now - entry.at < input.ttlMs) return entry.value
      const value = await input.load()
      entry = { at: Date.now(), value }
      return value
    },
    invalidate() {
      entry = undefined
    },
  }
}

/** Session create, update and delete events invalidate the list cache */
export function shouldInvalidateSessionListCache(type: unknown) {
  return type === "session.created" || type === "session.updated" || type === "session.deleted"
}
