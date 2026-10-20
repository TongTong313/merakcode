/**
 * Concurrent calls share one run: while it is in flight the same promise is returned, and the next call after it
 * settles runs again.
 */
export function createSingleFlight<T>(fn: () => Promise<T>) {
  let inFlight: Promise<T> | undefined

  return () => {
    if (inFlight) return inFlight

    inFlight = fn().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
}
