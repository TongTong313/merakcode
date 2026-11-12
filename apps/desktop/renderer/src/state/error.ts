import { ErrorCode } from "@merakcode/util/error-code"

/**
 * Error code and request id for the UI. Engine request failures are MerakCodeError (code, requestID); session
 * errors are plain { name, code, data } objects from the event stream.
 */
type Coded = { code?: unknown; requestID?: unknown; status?: unknown; message?: unknown; data?: { message?: unknown } }

const field = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : undefined)

/** An error raised by the desktop itself with a catalog code; the transport error stays in the cause. */
export class MerakCodeError extends Error {
  readonly code: string
  readonly requestID?: string
  readonly data?: unknown
  constructor(options: { code: string; message: string; cause?: unknown; requestID?: string; data?: unknown }) {
    super(options.message, { cause: options.cause })
    this.name = "MerakCodeError"
    this.code = options.code
    this.requestID = options.requestID
    this.data = options.data
  }
}

function read(
  error: unknown,
  seen = new Set<unknown>(),
): { code: string; message?: string; request?: string; status?: string } | undefined {
  if (typeof error !== "object" || error === null) return
  if (seen.has(error)) return
  seen.add(error)
  const value = error as Coded
  const code =
    field(value.code) ?? (typeof value.message === "string" ? /^MRK-\d{4}$/.exec(value.message)?.[0] : undefined)
  if (!code?.startsWith("MRK-")) return "cause" in error ? read(error.cause, seen) : undefined
  return {
    code,
    message: field(value.data?.message) ?? field(value.message),
    request: field(value.requestID),
    status: field(value.status),
  }
}

/** The MRK code of an error, looking through wrappers; the engine reports a failure as an Error whose message is the code */
export const codeOf = (error: unknown) => read(error)?.code

/** Any failure as a MerakCodeError, keeping its code (empty when it has none) and the original as the cause. */
export const fromError = (error: unknown): MerakCodeError =>
  error instanceof MerakCodeError
    ? error
    : new MerakCodeError({
        code: codeOf(error) ?? "",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })

/** Short line under the error, e.g. "MRK-1011 · req_1" */
export function summary(error: unknown) {
  const value = read(error)
  if (!value) return
  return [value.code, value.request].filter(Boolean).join(" · ")
}

export function explain(error: unknown, language: "zh" | "en") {
  const code = read(typeof error === "string" ? { message: error } : error)?.code
  const spec = Object.values(ErrorCode.CATALOG).find((item) => item.code === code)
  return spec ? { title: spec.title[language], hint: spec.hint[language] } : undefined
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
