import { ErrorCode } from "@merakcode/util/error-code"
import { MerakCodeError } from "../errors.js"

export class RequestTimeoutError extends MerakCodeError {
  constructor(message = "The engine did not answer in time") {
    super({ code: ErrorCode.CATALOG.REQUEST_TIMEOUT.code, message })
    this.name = "RequestTimeoutError"
  }
}

export interface RequestDeadlineTimer {
  set(run: () => void, delay: number): unknown
  clear(timer: unknown): void
}

export interface RequestDeadlineOptions {
  signal?: AbortSignal
  timeout?: number
  timer?: RequestDeadlineTimer
}

export async function withRequestDeadline<Value>(
  run: (signal: AbortSignal) => Promise<Value>,
  options: RequestDeadlineOptions = {},
): Promise<Value> {
  const timer =
    options.timer ??
    ({
      set: (run, delay) => setTimeout(run, delay),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } satisfies RequestDeadlineTimer)
  const deadline = new AbortController()
  const combined = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort?.(combined.reason ?? new DOMException("The operation was aborted", "AbortError"))
  combined.addEventListener("abort", onAbort, { once: true })
  const handle = timer.set(() => deadline.abort(new RequestTimeoutError()), options.timeout ?? 5_000)
  try {
    if (combined.aborted) throw combined.reason ?? new DOMException("The operation was aborted", "AbortError")
    return await Promise.race([run(combined), aborted])
  } finally {
    timer.clear(handle)
    combined.removeEventListener("abort", onAbort)
  }
}
