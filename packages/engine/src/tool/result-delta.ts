import { createHash } from "crypto"
import { Config } from "../config/config"
import { EnvVar } from "../util/env-var"

type Entry = {
  hash: string
  timestamp: number
  bytes: number
}

const MAX_CACHE_ENTRIES = 200
const cache = new Map<string, Entry>()

async function enabled() {
  const value = EnvVar.bool("MERAKCODE_EXPERIMENTAL_TOOL_RESULT_DELTA")
  if (value !== undefined) return value
  return (await Config.get()).experimental?.tool_result_delta === true
}

function hash(text: string) {
  return createHash("sha1").update(text).digest("hex")
}

function prune(now: number, ttlMs: number) {
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > ttlMs) cache.delete(key)
  }

  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export namespace ToolResultDelta {
  export function clear() {
    cache.clear()
  }

  export async function check(input: {
    tool: string
    sessionID: string
    key: string
    output: string
    ttlMs: number
  }): Promise<string | null> {
    if (!(await enabled())) return null

    const now = Date.now()
    prune(now, input.ttlMs)

    const cacheKey = [input.sessionID, input.tool, input.key].join("\u0000")
    const outputHash = hash(input.output)
    const previous = cache.get(cacheKey)

    if (previous && previous.hash === outputHash && now - previous.timestamp <= input.ttlMs) {
      const secondsAgo = Math.max(1, Math.round((now - previous.timestamp) / 1000))
      previous.timestamp = now
      return `[unchanged] same ${input.tool} result as previous run ${secondsAgo}s ago (${previous.bytes} bytes).`
    }

    cache.set(cacheKey, {
      hash: outputHash,
      timestamp: now,
      bytes: Buffer.byteLength(input.output, "utf8"),
    })
    return null
  }
}
