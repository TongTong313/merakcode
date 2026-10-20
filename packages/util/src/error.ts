import z from "zod"
import { ErrorCode } from "./error-code"

export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType
  abstract toObject(): { name: string; code?: string; data: any }

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        /** Stable error code from the catalog, e.g. MRK-2002 (see docs/errors.md) */
        code: z.string().optional(),
        data,
      })
      .meta({
        ref: name,
      })
    const result = class extends NamedError {
      public static readonly Schema = schema

      public override readonly name = name as Name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && input !== null && "name" in input && input.name === name
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          code: ErrorCode.of(name, this.data),
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
    }),
  )
}

/** The MRK-dddd code an error carries; named errors from before codes existed are looked up by name */
export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) && !(error instanceof Error)) return
  const value = error as { code?: unknown; name?: unknown; data?: unknown }
  if (typeof value.code === "string" && /^MRK-\d{4}$/.test(value.code)) return value.code
  if (typeof value.name === "string" && !(error instanceof Error)) return ErrorCode.of(value.name, value.data)
}

/** Whether the error is a user-initiated abort (MessageAbortedError); shared by the TUI and the web UI */
export function isMessageAbortedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "MessageAbortedError"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pickMessageFields(obj: Record<string, unknown>): string | undefined {
  const errorMessage = typeof obj.errorMessage === "string" ? obj.errorMessage.trim() : ""
  if (errorMessage) return errorMessage
  const message = typeof obj.message === "string" ? obj.message.trim() : ""
  if (message) return message
  const error = typeof obj.error === "string" ? obj.error.trim() : ""
  if (error) return error
  return undefined
}

function usableText(value: string | undefined): string | undefined {
  if (!value || value.startsWith("[object ")) return undefined
  return value
}

/**
 * Extracts readable text from a provider or gateway error wrapped in JSON.
 * Supports `{ message }`, `{ error: { type, message } }` and `{ errorCode, errorMessage }`.
 */
export function unwrapErrorText(message: string): string {
  const text = message.replace(/^Error:\s*/, "").trim()
  if (!text) return message

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)
  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
  }

  if (!isRecord(json)) return message

  const err = isRecord(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = pickMessageFields(err)
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = pickMessageFields(json)
  if (msg) return msg
  return message
}

/**
 * Extracts user-readable error text from a NamedError, a retry payload or gateway JSON.
 * Never returns "[object Object]".
 */
export function readableErrorText(value: unknown, fallback = "", depth = 0): string {
  if (value == null || depth > 4) return fallback
  if (typeof value === "string") return usableText(unwrapErrorText(value)) ?? fallback
  if (typeof value === "number" || typeof value === "boolean") return String(value)

  if (isRecord(value) || typeof value === "object") {
    const obj = value as Record<string, unknown>
    if (isRecord(obj.data)) {
      const fromDataMessage = readableErrorText(obj.data.message, "", depth + 1)
      if (fromDataMessage) return fromDataMessage
      const fromData = pickMessageFields(obj.data)
      if (fromData) return usableText(unwrapErrorText(fromData)) ?? fallback
    }

    const fromTop = pickMessageFields(obj)
    if (fromTop) return usableText(unwrapErrorText(fromTop)) ?? fallback

    if (isRecord(obj.message)) {
      const nested = readableErrorText(obj.message, "", depth + 1)
      if (nested) return nested
    }
  }

  if (value instanceof Error) {
    const fromError = usableText(unwrapErrorText(value.message))
    if (fromError && fromError !== value.name) return fromError
  }

  return fallback
}

/**
 * Translates a session.error event from its code, params and message.
 * @param error - the error object of the session.error event
 * @param t - i18n translate function (TUI: locale.t, Web: i18n.t)
 * @returns the translated message when a code exists and translates, otherwise the readable fallback message
 */
export function localizeError(error: unknown, t: (key: string, params?: Record<string, any>) => string): string {
  if (!error || typeof error !== "object") return typeof error === "string" ? error : String(error)

  const errorObj = error as Record<string, unknown>
  const data = isRecord(errorObj.data) ? errorObj.data : undefined

  if (data) {
    const code = typeof data.messageKey === "string" ? data.messageKey : undefined
    const params = isRecord(data.params) ? data.params : undefined

    if (code) {
      let keyToTry = code
      if (params) {
        if (typeof params.suggestions === "string" && params.suggestions.trim()) {
          keyToTry = code + ".withSuggestions"
        } else if (typeof params.available === "string" && params.available.trim()) {
          keyToTry = code + ".withAvailable"
        }
      }
      try {
        const translated = t(keyToTry, params ?? {})
        if (translated && translated !== keyToTry) return translated
        if (keyToTry !== code) {
          const fallbackTranslated = t(code, params ?? {})
          if (fallbackTranslated && fallbackTranslated !== code) return fallbackTranslated
        }
      } catch {
        // fall back to the readable message
      }
    }
  }

  return readableErrorText(error)
}

/**
 * Translates a NotifyEvent.ToastShow event from its codes, params and original text.
 * @param toast - the NotifyEvent.ToastShow event
 * @param t - i18n translate function (TUI: locale.t, Web: i18n.t)
 * @returns the translated { title, message }
 */
export function localizeToast(
  toast: {
    title?: string
    message: string
    titleCode?: string
    messageCode?: string
    params?: Record<string, any>
  },
  t: (key: string, params?: Record<string, any>) => string,
): { title: string; message: string } {
  const params = toast.params ?? {}

  let title = toast.title
  if (toast.titleCode && typeof toast.titleCode === "string") {
    try {
      const translated = t(toast.titleCode, params)
      // i18n may return the key itself when it is missing; keep the original title then
      if (translated && translated !== toast.titleCode) title = translated
    } catch {
      // keep the original title
    }
  }

  let message = toast.message
  if (toast.messageCode && typeof toast.messageCode === "string") {
    try {
      const translated = t(toast.messageCode, params)
      // i18n may return the key itself when it is missing; keep the original message then
      if (translated && translated !== toast.messageCode) message = translated
    } catch {
      // keep the original message
    }
  }

  return { title: title ?? "", message }
}
