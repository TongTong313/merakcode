import { createHash } from "crypto"
import type { CompactContext } from "./types"

type CacheEntry = {
  hash: string
  timestamp: number
  bytes: number
}

const MAX_CACHE_ENTRIES = 100
const MAX_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

function normalize(command: string) {
  return command.replace(/\s+/g, " ").trim()
}

function hash(text: string) {
  return createHash("sha1").update(text).digest("hex")
}

function firstCommand(command: string) {
  const segment = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? ""
  return segment.trim().split(/\s+/)[0] ?? ""
}

function ttl(command: string) {
  const normalized = normalize(command)
  const first = firstCommand(normalized)
  if (["git", "ls", "find", "rg", "grep", "ag", "ack"].includes(first)) return 30_000
  if (/\b(test|pytest|jest|vitest|cargo test|bun test|npm test|pnpm test|yarn test)\b/.test(normalized)) return 120_000
  return MAX_TTL_MS
}

function key(context: CompactContext) {
  return [context.sessionID ?? "", context.cwd, String(context.exitCode), normalize(context.command)].join("\u0000")
}

export function clearSessionDeltaCache() {
  cache.clear()
}

export function commandMayMutateWorkspace(command: string) {
  const normalized = normalize(command)
  return /(^|[;&|]\s*)(git\s+(add|commit|checkout|switch|reset|merge|rebase|cherry-pick|revert|pull|push|clean|stash|mv|rm)|rm\b|mv\b|cp\b|mkdir\b|rmdir\b|touch\b|chmod\b|chown\b|npm\s+(install|i|ci|update)|pnpm\s+(install|i|update)|yarn\s+(install|add|remove|upgrade)|bun\s+(install|add|remove|update))\b/.test(
    normalized,
  )
}

function prune(now: number) {
  for (const [entryKey, entry] of cache) {
    if (now - entry.timestamp > MAX_TTL_MS) cache.delete(entryKey)
  }

  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function applySessionDelta(context: CompactContext): string | null {
  const now = Date.now()
  prune(now)

  if (commandMayMutateWorkspace(context.command)) {
    clearSessionDeltaCache()
    return null
  }

  const entryKey = key(context)
  const outputHash = hash(context.stdout)
  const previous = cache.get(entryKey)
  const maxAge = ttl(context.command)

  if (previous && previous.hash === outputHash && now - previous.timestamp <= maxAge) {
    const secondsAgo = Math.max(1, Math.round((now - previous.timestamp) / 1000))
    previous.timestamp = now
    return `[unchanged] same output as previous \`${normalize(context.command)}\` run ${secondsAgo}s ago (${previous.bytes} bytes).`
  }

  cache.set(entryKey, {
    hash: outputHash,
    timestamp: now,
    bytes: Buffer.byteLength(context.stdout, "utf8"),
  })
  return null
}
