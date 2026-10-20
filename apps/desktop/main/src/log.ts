import { buildRecord, type LogLevel } from "@merakcode/log"
import { FileSink, resolveLogRoot } from "@merakcode/log/node"
import { randomUUID } from "node:crypto"
import path from "node:path"

/**
 * Desktop main process log: same log directory as the engine (<data dir>/merakcode/log), under desktop/.
 * Logs the renderer sends over the bridge are written here too, with the source in the service name.
 */
export namespace Log {
  let sink: FileSink | undefined
  let sequence = 0
  const run = randomUUID()

  export function init(options: { dev: boolean }) {
    sink = new FileSink({ component: "main", directory: ["desktop"], dev: options.dev })
  }

  export function write(level: LogLevel, service: string, message: string, attributes?: Record<string, unknown>) {
    const record = buildRecord({
      level,
      component: "desktop-main",
      service,
      message,
      runId: run,
      sequence: sequence++,
      attributes,
    })
    sink?.write(JSON.stringify(record) + "\n")
    if (!sink || process.env.MERAKCODE_DESKTOP_DEV) console.log(`[${level}] ${service} ${message}`, attributes ?? "")
  }

  export function create(service: string) {
    return {
      info: (message: string, extra?: Record<string, unknown>) => write("INFO", service, message, extra),
      warn: (message: string, extra?: Record<string, unknown>) => write("WARN", service, message, extra),
      error: (message: string, extra?: Record<string, unknown>) => write("ERROR", service, message, extra),
    }
  }

  /** Directory opened by "Open log directory" in settings */
  export function directory(dev: boolean) {
    return path.join(resolveLogRoot(), dev ? "development" : "production")
  }

  export async function close() {
    await sink?.close()
  }
}
