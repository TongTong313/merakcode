import { createMerakCodeClient, type MerakCodeClient } from "@merakcode/sdk/client"
import { fromResponse } from "@merakcode/sdk/errors"

/**
 * Engine clients. The UI is loaded from the local backend, so the base URL is the page origin; the main process adds
 * the auth token to requests sent to the backend. The engine picks the project instance from the directory header, so
 * there is one client per directory.
 */
const clients = new Map<string, MerakCodeClient>()

export function client(directory?: string) {
  const key = directory ?? ""
  const existing = clients.get(key)
  if (existing) return existing
  const created = createMerakCodeClient({ baseUrl: location.origin, ...(directory ? { directory } : {}) })
  clients.set(key, created)
  return created
}

/** Calls the engine; a failure throws MerakCodeError with the error code and request id */
export async function call<T>(request: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
  const result = await request
  if (result.error !== undefined) throw fromResponse(result.error, result.response)
  return result.data as T
}
