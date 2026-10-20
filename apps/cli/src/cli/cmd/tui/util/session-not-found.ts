/** With throwOnError, hey-api throws the HTTP JSON body, not an Error instance. */
export function isSessionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as {
    status?: number
    name?: string
    error?: { name?: string }
    data?: { name?: string }
  }
  if (e.status === 404) return true
  if (e.name === "NotFoundError") return true
  if (e.error?.name === "NotFoundError") return true
  if (e.data?.name === "NotFoundError") return true
  return false
}

export function homeRouteIfSessionNotFound(error: unknown): { type: "home" } | undefined {
  if (!isSessionNotFoundError(error)) return undefined
  return { type: "home" }
}
