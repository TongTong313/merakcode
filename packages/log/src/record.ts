export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

export interface LogRecord {
  schema: "merakcode.log.v1"
  timestamp: string
  level: LogLevel
  component: string
  service: string
  message: string
  run_id: string
  sequence: number
  pid: number
  attributes?: Record<string, unknown>
}

export interface RecordInput {
  level: LogLevel
  component: string
  service: string
  message?: unknown
  runId: string
  sequence: number
  pid?: number
  timestamp?: Date
  attributes?: Record<string, unknown>
}

const secret =
  /(^|[_-])(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)($|[_-])|apiKey|accessKey|privateKey|accessToken|refreshToken|idToken/i
const bearer = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi
const privateContent =
  /^(prompt|messages|content|body|requestBody|responseBody|headers|stdout|stderr|command|sourceCode|source|toolInput|toolOutput|userName|euserId|email|phone|claims)$/i
const MAX_DEPTH = 6
const MAX_ITEMS = 100
const MAX_STRING = 8_192

function text(input: string) {
  const value = input
    .replace(bearer, "$1 <redacted>")
    .replace(
      /((?:["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret|token|authorization|cookie)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi,
      "$1<redacted>",
    )
    .replace(/(--(?:token|password|api-key|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url)
        parsed.username = ""
        parsed.password = ""
        parsed.search = parsed.search ? "?<redacted>" : ""
        parsed.hash = ""
        return parsed.toString()
      } catch {
        return "<url>"
      }
    })
  const suffix = "…<truncated>"
  return value.length <= MAX_STRING ? value : value.slice(0, MAX_STRING - suffix.length) + suffix
}

function clean(input: unknown, depth: number, seen: WeakSet<object>, budget: { left: number }): unknown {
  if ((budget.left -= 32) <= 0) return "<truncated>"
  if (input === null || input === undefined || typeof input === "boolean" || typeof input === "number") return input
  if (typeof input === "string") {
    const value = text(input).slice(0, Math.max(0, budget.left))
    budget.left -= value.length
    return value
  }
  if (typeof input === "bigint") return input.toString()
  if (typeof input === "symbol" || typeof input === "function") return String(input)
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : "<invalid-date>"
  if (seen.has(input)) return "<circular>"
  seen.add(input)
  if (input instanceof Error) {
    return {
      name: input.name,
      message: text(input.message),
      stack: input.stack ? text(input.stack) : undefined,
      cause: depth < MAX_DEPTH ? clean(input.cause, depth + 1, seen, budget) : "<max-depth>",
    }
  }
  if (depth >= MAX_DEPTH) return "<max-depth>"
  if (Array.isArray(input)) return input.slice(0, MAX_ITEMS).map((item) => clean(item, depth + 1, seen, budget))
  const entries = Object.entries(input as Record<string, unknown>).slice(0, MAX_ITEMS)
  return Object.fromEntries(
    entries
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        text(key).slice(0, 100),
        secret.test(key) || privateContent.test(key) ? "<redacted>" : clean(value, depth + 1, seen, budget),
      ]),
  )
}

/** Converts arbitrary diagnostic data into bounded, JSON-safe data and removes common credentials. */
export function sanitize(input: unknown): unknown {
  try {
    return clean(input, 0, new WeakSet(), { left: 16384 })
  } catch {
    return "<unserializable>"
  }
}

function message(input: unknown) {
  if (input === undefined || input === null) return ""
  if (typeof input === "string") return text(input)
  if (input instanceof Error) return text(input.message)
  const value = sanitize(input)
  if (typeof value === "string") return value
  try {
    return text(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

export function buildRecord(input: RecordInput): LogRecord {
  const attributes = sanitize(input.attributes) as Record<string, unknown> | undefined
  const record: LogRecord = {
    schema: "merakcode.log.v1",
    timestamp:
      input.timestamp && Number.isFinite(input.timestamp.getTime())
        ? input.timestamp.toISOString()
        : new Date().toISOString(),
    level: input.level,
    component: text(input.component).slice(0, 100),
    service: text(input.service).slice(0, 100),
    message: message(input.message),
    run_id: text(input.runId).slice(0, 100),
    sequence: input.sequence,
    pid: input.pid ?? (typeof process === "undefined" ? 0 : process.pid),
    ...(attributes && typeof attributes === "object" && Object.keys(attributes).length > 0 ? { attributes } : {}),
  }
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 60 * 1024) record.attributes = { truncated: true }
  return record
}

export function formatText(record: LogRecord) {
  const suffix = record.attributes
    ? " " +
      Object.entries(record.attributes)
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
        .join(" ")
    : ""
  return `${record.level.padEnd(5)} ${record.timestamp} component=${record.component} service=${record.service} run_id=${record.run_id} ${record.message}${suffix}\n`
}
