export type SessionMessageLoadState =
  { status: "idle" } | { status: "loading" } | { status: "loaded" } | { status: "error"; error: string }

interface SessionMessageLoaderOptions {
  get(sessionID: string): SessionMessageLoadState
  set(sessionID: string, state: SessionMessageLoadState): void
  load(sessionID: string, context: { isCurrent(): boolean }): Promise<void>
}

export function mergeSessionSnapshot<T extends { id: string }>(
  snapshot: T[],
  cached: T[],
  changedSinceRequest: (id: string) => boolean = () => false,
) {
  const current = new Map(cached.map((item) => [item.id, item]))
  const result = new Map(snapshot.map((item) => [item.id, item]))
  const changed = new Set([...result.keys(), ...current.keys()].filter(changedSinceRequest))

  for (const [id, item] of current) {
    if (!result.has(id) || changed.has(id)) result.set(id, item)
  }
  for (const id of changed) {
    if (!current.has(id)) result.delete(id)
  }
  return [...result.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function limitSessionSnapshot<T>(items: T[], limit: number) {
  if (!Number.isFinite(limit) || items.length <= limit) return items
  const count = Math.max(0, Math.floor(limit))
  return count === 0 ? [] : items.slice(-count)
}

export function createSessionMessageLoader(options: SessionMessageLoaderOptions) {
  const generations = new Map<string, number>()
  const flights = new Map<string, { generation: number; promise: Promise<void> }>()

  function run(sessionID: string) {
    const current = flights.get(sessionID)
    if (current) return current.promise
    if (options.get(sessionID).status === "loaded") return Promise.resolve()

    const generation = (generations.get(sessionID) ?? 0) + 1
    generations.set(sessionID, generation)
    const isCurrent = () => generations.get(sessionID) === generation
    const flight = Promise.resolve()
      .then(() => options.load(sessionID, { isCurrent }))
      .then(() => {
        if (isCurrent()) options.set(sessionID, { status: "loaded" })
      })
      .catch((error) => {
        if (!isCurrent()) return
        options.set(sessionID, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      })
      .finally(() => {
        if (flights.get(sessionID)?.generation === generation) flights.delete(sessionID)
      })

    flights.set(sessionID, { generation, promise: flight })
    options.set(sessionID, { status: "loading" })
    return flight
  }

  return {
    ensure(sessionID: string) {
      return run(sessionID)
    },
    loaded(sessionID: string) {
      generations.set(sessionID, (generations.get(sessionID) ?? 0) + 1)
      flights.delete(sessionID)
      options.set(sessionID, { status: "loaded" })
    },
  }
}
