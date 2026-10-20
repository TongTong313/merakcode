import { ErrorCode } from "@merakcode/util/error-code"

/**
 * Every error the SDK throws. `code` is a stable MerakCode error code (see docs/errors.md);
 * `requestID` matches the engine log line for that request when the error came from the engine.
 */
export class MerakCodeError extends Error {
  readonly code: string
  readonly status?: number
  readonly requestID?: string
  readonly data?: unknown
  readonly retryable: boolean

  constructor(input: {
    code: string
    message: string
    status?: number
    requestID?: string
    data?: unknown
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "MerakCodeError"
    this.code = input.code
    this.status = input.status
    this.requestID = input.requestID
    this.data = input.data
    this.retryable = ErrorCode.spec(input.code)?.retryable ?? false
  }
}

export function isMerakCodeError(error: unknown): error is MerakCodeError {
  return error instanceof MerakCodeError
}

const byStatus: Record<number, ErrorCode.Name> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  504: "REQUEST_TIMEOUT",
}

/** Turns the `error` of a failed client call (plus its response) into a MerakCodeError */
export function fromResponse(error: unknown, response?: Response): MerakCodeError {
  const body = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
  const status = response?.status
  const named = typeof body.name === "string" ? ErrorCode.of(body.name, body.data) : undefined
  const code =
    (typeof body.code === "string" && body.code) ||
    (named !== ErrorCode.CATALOG.INTERNAL.code && named) ||
    ErrorCode.CATALOG[(status && byStatus[status]) || "INTERNAL"].code
  const data = body.data as { message?: unknown } | undefined
  const message =
    (typeof body.message === "string" && body.message) ||
    (typeof data?.message === "string" && data.message) ||
    (typeof error === "string" && error) ||
    ErrorCode.spec(code)?.title.en ||
    `Request failed${status ? ` with HTTP ${status}` : ""}`
  return new MerakCodeError({
    code,
    message,
    status,
    requestID:
      (typeof body.requestID === "string" && body.requestID) || response?.headers.get("x-request-id") || undefined,
    data: body.data,
  })
}
