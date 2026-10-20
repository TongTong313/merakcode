import { Log } from "@merakcode/log/logger"

function logError(kind: string, error: unknown) {
  Log.Product.error(kind, {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  })
}

/** Installs global error handlers that only log and never exit; each command handles its own shutdown. */
export function installFatalHandlers() {
  process.on("unhandledRejection", (error) => {
    logError("unhandled rejection", error)
  })
  process.on("uncaughtException", (error) => {
    logError("uncaught exception", error)
  })
}
