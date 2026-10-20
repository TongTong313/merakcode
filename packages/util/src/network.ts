import { createServer, type AddressInfo } from "node:net"

/**
 * Network error classification. Node's fetch (undici) fails with TypeError("terminated" or "fetch failed") and the
 * real reason is in cause.code; node:http, ws and others throw errors with code directly. Both are checked.
 * Callers only care about "connection dropped" (retryable) and "unreachable" (worded differently for the user), so
 * they should not match error text themselves.
 */
export namespace Network {
  export type Failure = "reset" | "unreachable"

  const RESET = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"])
  const UNREACHABLE = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ])

  export function failure(error: unknown): Failure | undefined {
    if (!(error instanceof Error)) return
    const codes = [code(error), code(error.cause)]
    if (codes.some((item) => item && RESET.has(item))) return "reset"
    if (codes.some((item) => item && UNREACHABLE.has(item))) return "unreachable"
  }

  /** Finds a free port by listening on port 0 to get one from the OS, then closing */
  export function freePort(hostname = "127.0.0.1") {
    return new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(0, hostname, () => {
        const { port } = server.address() as AddressInfo
        server.close(() => resolve(port))
      })
    })
  }

  function code(value: unknown) {
    if (!value || typeof value !== "object" || !("code" in value)) return
    return typeof value.code === "string" ? value.code : undefined
  }
}
