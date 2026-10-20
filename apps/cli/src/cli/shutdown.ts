import { setTimeout as delay } from "node:timers/promises"
const SIGNALS: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  ...(process.platform === "win32" ? (["SIGBREAK"] as NodeJS.Signals[]) : []),
]
const SHUTDOWN_TIMEOUT_MS = 5_000

export function waitForShutdown(cleanup: () => Promise<unknown>) {
  return new Promise<void>((resolve) => {
    let pending: Promise<void> | undefined

    const shutdown = () => {
      if (pending) return pending
      pending = Promise.race([Promise.resolve().then(cleanup), delay(SHUTDOWN_TIMEOUT_MS)])
        .catch(() => undefined)
        .then(() => {
          for (const signal of SIGNALS) process.off(signal, shutdown)
          process.off("disconnect", shutdown)
          resolve()
        })
      return pending
    }

    for (const signal of SIGNALS) process.once(signal, shutdown)
    // When spawned over IPC (desktop app), shut down once the channel disconnects, which happens whether the parent
    // exits or crashes. Windows cannot deliver SIGTERM, so this is the only way to exit gracefully without orphans.
    if (process.connected) process.once("disconnect", shutdown)
  })
}

const hooks: (() => Promise<unknown>)[] = []

/**
 * Cleanup before process exit. Commands that load the engine (serve, debug, etc.) register engine cleanup here and the
 * CLI entry runs it before exiting; the entry never loads the engine itself, so it cannot know whether it was used.
 */
export const Exit = {
  register(cleanup: () => Promise<unknown>) {
    hooks.push(cleanup)
  },
  run() {
    return Promise.all(hooks.map((cleanup) => cleanup().catch(() => undefined)))
  },
}
