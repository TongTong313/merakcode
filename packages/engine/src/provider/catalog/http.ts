import { Installation } from "../../installation"
import { withTrustedTls } from "@merakcode/util/tls"

/** A model-list request that came back with an HTTP error. The message never includes the API key. */
export class CatalogRequestError extends Error {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = "CatalogRequestError"
    this.statusCode = statusCode
  }
}

export async function getJSON(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(
    url,
    withTrustedTls({
      headers: { "User-Agent": Installation.USER_AGENT, ...headers },
      signal: AbortSignal.timeout(15_000),
    }),
  )
  if (!response.ok) throw new CatalogRequestError(`catalog ${response.status} ${url}`, response.status)
  return response.json()
}

export function bearer(key: string) {
  return { Authorization: `Bearer ${key}` }
}

/** Joins a list path onto a base URL without duplicating a trailing /models. */
export function modelsURL(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/models") ? trimmed : `${trimmed}/models`
}
