// Test-only egress guard, installed before the product entry. Never replaces target APIs.
import { appendFileSync } from "node:fs"
const original = globalThis.fetch
globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  if (!["file:", "data:"].includes(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    if (process.env.MERAKCODE_I1_NETWORK_LOG) appendFileSync(process.env.MERAKCODE_I1_NETWORK_LOG, `${url.hostname}\n`)
    throw new Error(`I1 blocked nonlocal fetch: ${url.hostname}`)
  }
  return original(input, init)
}) as typeof fetch
