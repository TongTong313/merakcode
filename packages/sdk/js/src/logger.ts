/** One line from the SDK's optional logger: engine start and exit, and failed requests. Nothing is logged by default. */
export type LogEntry = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data?: Record<string, unknown>
}

export type Logger = (entry: LogEntry) => void
