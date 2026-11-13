import type { EngineEvent, ProtocolImportStatus } from "@merakcode/sdk"
import { createSignal } from "solid-js"
import { log } from "../lib/bridge"
import { onConnection } from "./client"
import { listen } from "./store"

/** How far the import of an earlier version is; it runs in the background of the engine, one conversation at a time. */
export type ImportProgress = { running: boolean; done: number; total: number }

const [progress, setProgress] = createSignal<ImportProgress>({ running: false, done: 0, total: 0 })
export { progress as importProgress, setProgress as setImportProgress }

/** What an import.progress event says; it is running until every conversation and group is done. */
export function progressOf(event: EngineEvent): ImportProgress | undefined {
  if (event.type !== "import.progress") return
  const { done, total } = event.payload
  return { running: done < total, done, total }
}

/** The same picture from the status of the engine, which a window asks for when it connects mid-import. */
export const statusProgress = (status: ProtocolImportStatus): ImportProgress => ({
  running: status.state === "running",
  done: status.done,
  total: status.total,
})

/** Follows the import: the status when the connection opens, then every progress event. */
export function connectImport() {
  const stopEvents = listen((_directory, event) => {
    const next = progressOf(event)
    if (next) setProgress(next)
  })
  const stopConnection = onConnection((connection) => {
    if (!connection) return
    void connection.import
      .status()
      .then((status) => setProgress(statusProgress(status)))
      .catch(() => log("error", "import status request failed", { code: "MRK-1003" }))
  })
  return () => {
    stopEvents()
    stopConnection()
  }
}
