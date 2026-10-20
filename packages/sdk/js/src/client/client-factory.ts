/**
 * Shared client construction (header injection, disabling fetch's default timeouts on Node).
 * Kept apart from `index.ts`, which only wires the generated code together, so hand-written logic is easy to tell
 * apart when the SDK is regenerated.
 */
import type { Logger } from "../logger.js"

interface WorkspaceFolderInput {
  name?: string
  path: string
}

export interface ClientConfig {
  directory?: string
  /** Folders of a multi-root workspace; when omitted the header is not sent (CLI / single root) */
  workspaceFolders?: WorkspaceFolderInput[]
  fetch?: typeof fetch
  headers?: unknown
  /** Your own run or trace id; the engine writes it into the log line of every request */
  clientRun?: string
  /** Called for every request that fails */
  logger?: Logger
}

function encodeHeaderValue(value: string) {
  return /[^\x00-\x7F]/.test(value) ? encodeURIComponent(value) : value
}

/**
 * Merges extra headers into the caller's headers. Headers objects and tuples cannot be spread (spreading Headers gives
 * an empty object, spreading tuples gives numeric keys), so they are converted to real Headers first. Plain objects
 * are still spread so the generated client's handling of object values (arrays for multiple values, null to remove)
 * keeps working.
 */
function withHeaders(input: unknown, extra: Record<string, string>) {
  if (input instanceof Headers || Array.isArray(input)) {
    const headers = new Headers(input as HeadersInit)
    for (const [key, value] of Object.entries(extra)) headers.set(key, value)
    return headers
  }
  return { ...((input as Record<string, string> | undefined) ?? {}), ...extra }
}

/**
 * Node's fetch waits at most 5 minutes for response headers and 5 minutes between body chunks. A synchronous prompt
 * only gets its response after the whole turn finishes, so long tasks would be cut off. On Node, requests go through
 * undici with a connection pool that has neither timeout.
 * The pool and fetch must come from the same undici: Node's built-in fetch uses a different undici (7.x in Node 24)
 * that does not accept this pool. The generated client passes a global Request, which is split into URL and options
 * for undici.
 * Browser fetch has no such limit, so undici is not loaded there (the module name is a variable so bundlers leave it
 * out of web builds).
 */
type Fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
let unbounded: Promise<Fetch> | undefined
function nodeFetch() {
  if (typeof process === "undefined" || !process.versions?.node) return
  const name = "undici"
  return (unbounded ??= import(/* @vite-ignore */ name).then(({ Agent, fetch: send }) => {
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
    return async (input, init) => {
      const request = new Request(input, init)
      return send(request.url, {
        method: request.method,
        headers: [...request.headers],
        body: request.body ? await request.arrayBuffer() : undefined,
        signal: request.signal,
        redirect: request.redirect,
        dispatcher,
      }) as Promise<Response>
    }
  }))
}

/** Reports failed requests to the logger; the response itself is passed on untouched */
function logged(send: Fetch, logger: Logger): Fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const response = await send(input, init).catch((error: Error) => {
      logger({ level: "error", message: "request error", data: { method, path, error: error.message } })
      throw error
    })
    if (response.ok) return response
    const body = (await response
      .clone()
      .json()
      .catch(() => undefined)) as { code?: unknown } | undefined
    logger({
      level: "warn",
      message: "request failed",
      data: {
        method,
        path,
        status: response.status,
        code: typeof body?.code === "string" ? body.code : undefined,
        requestID: response.headers.get("x-request-id") ?? undefined,
      },
    })
    return response
  }
}

export function createSdkClient<Config extends ClientConfig, Transport, Client>(
  config: Config | undefined,
  create: (config?: Config) => Transport,
  Client: new (args: { client: Transport }) => Client,
) {
  const customFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const send = await nodeFetch()
    return send ? send(input, init) : fetch(input, init)
  }, fetch)
  const base = config?.fetch ?? customFetch
  const send = config?.logger ? Object.assign(logged(base, config.logger), fetch) : base

  const extra: Record<string, string> = {}
  if (config?.directory) {
    extra["x-merakcode-directory"] = encodeHeaderValue(config.directory)
  }
  if (config?.workspaceFolders && config.workspaceFolders.length > 0) {
    extra["x-merakcode-workspace-folders"] = encodeURIComponent(JSON.stringify(config.workspaceFolders))
  }
  if (config?.clientRun) extra["x-merakcode-client-run"] = encodeHeaderValue(config.clientRun)

  const input = config?.headers
  const headers = withHeaders(input, extra)

  const next = {
    ...config,
    ...(send !== config?.fetch ? { fetch: send } : {}),
    ...(input !== undefined || Object.keys(extra).length > 0 ? { headers } : {}),
  } as Config
  return new Client({ client: create(next) })
}
