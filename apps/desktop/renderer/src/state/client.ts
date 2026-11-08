import { connect } from "@merakcode/sdk"
import metadata from "../../package.json" with { type: "json" }

export type EngineClient = Awaited<ReturnType<typeof connect>>
type Listener = (client: EngineClient | undefined) => void
const listeners = new Set<Listener>()
let current: EngineClient | undefined
let opening: Promise<EngineClient> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let persistent = false
let failures = 0

function retry() {
  if (!persistent || timer) return
  timer = setTimeout(
    () => {
      timer = undefined
      void client().catch(retry)
    },
    Math.min(250 * 2 ** Math.min(failures++, 5), 5000),
  )
}

/** One multiplexed connection; Electron injects its bearer token outside the renderer. */
export function client(): Promise<EngineClient> {
  if (current) return Promise.resolve(current)
  if (opening) return opening
  opening = connect({
    endpoint: `ws://${location.host}/rpc`,
    approve: true,
    client: { name: "desktop-renderer", version: metadata.version },
  })
    .then((connection) => {
      current = connection
      failures = 0
      for (const listener of listeners) listener(connection)
      void connection.closed.then(() => {
        if (current !== connection) return
        current = undefined
        for (const listener of listeners) listener(undefined)
        retry()
      })
      return connection
    })
    .finally(() => {
      opening = undefined
    })
  return opening
}

export function onConnection(listener: Listener) {
  listeners.add(listener)
  if (current) listener(current)
  return () => {
    listeners.delete(listener)
  }
}

export function startConnection() {
  persistent = true
  void client().catch(retry)
  return () => {
    persistent = false
    clearTimeout(timer)
    timer = undefined
    const closing = current ? current.close() : opening?.then((connection) => connection.close())
    void closing?.catch(() => {})
  }
}
