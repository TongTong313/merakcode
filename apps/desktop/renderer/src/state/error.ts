/**
 * Error code and request id for the UI. Engine request failures are MerakCodeError (code, requestID); session
 * errors are plain { name, code, data } objects from the event stream.
 */
type Coded = { code?: unknown; requestID?: unknown; status?: unknown; message?: unknown; data?: { message?: unknown } }

const field = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : undefined)

function read(error: unknown) {
  if (typeof error !== "object" || error === null) return
  const value = error as Coded
  const code = field(value.code)
  if (!code?.startsWith("MRK-")) return
  return {
    code,
    message: field(value.data?.message) ?? field(value.message),
    request: field(value.requestID),
    status: field(value.status),
  }
}

/** Short line under the error, e.g. "MRK-1011 · req_1" */
export function summary(error: unknown) {
  const value = read(error)
  if (!value) return
  return [value.code, value.request].filter(Boolean).join(" · ")
}

/** Text for "Copy details", meant to be pasted into a bug report */
export function details(error: unknown, context: { version: string; platform: string; time: string }) {
  const value = read(error)
  const message = value?.message ?? (error instanceof Error ? error.message : String(error))
  return [
    ["code", value?.code],
    ["message", message],
    ["request", value?.request],
    ["status", value?.status],
    ["version", context.version],
    ["platform", context.platform],
    ["time", context.time],
  ]
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([key, text]) => `${key}: ${text}`)
    .join("\n")
}
