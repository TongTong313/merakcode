import { connectTerminal, type TerminalConnection } from "@merakcode/sdk"
import { client } from "../../state/client"
import { codeOf } from "../../state/error"
import { sameDir } from "../../lib/route"
import { listen } from "../../state/store"
import type { PanelTab, Panels } from "../panel/state"
import { log } from "../../lib/bridge"

type Address = { directory: string; ptyID: string }
type Resource = {
  directory: string
  sessionID?: string
  panels: Panels
  request: Promise<Address | undefined>
  binding?: Promise<void>
  ptyID?: string
  failed?: boolean
  input?: TerminalConnection
  queued: string[]
}
const resources = new Map<string, Resource>()
let timer: ReturnType<typeof setInterval> | undefined

/** Live and retrying terminals must keep the same writable layout as background browser events. */
export function hasTerminals(panels: Panels) {
  return [...resources.values()].some((resource) => resource.panels === panels)
}

function release(id: string, resource?: Resource) {
  if (resource && resources.get(id) !== resource) return
  resources.get(id)?.input?.close()
  resources.delete(id)
  if (resources.size) return
  clearInterval(timer)
  timer = undefined
}

/** One input stream preserves key order across views, including input submitted before creation finishes. */
export async function sendTerminalInput(id: string, data: string) {
  if (!data) return
  const resource = resources.get(id)
  if (!resource) return
  resource.queued.push(data)
  const address = await resource.request
  if (!address || resources.get(id) !== resource) return
  flushInput(resource, address)
}

function flushInput(resource: Resource, address: Address) {
  if (!resource.queued.length) return
  if (!resource.input) {
    const connection = connectTerminal({
      endpoint: location.origin,
      id: address.ptyID,
      // The output replay is not needed: this stream only carries keys.
      onData() {},
      onClose() {
        resetInput(resource, connection)
      },
      onError() {
        resetInput(resource, connection)
        connection.close()
        log("warn", "terminal input connection failed")
      },
    })
    resource.input = connection
    resource.failed = false
  }
  for (const data of resource.queued.splice(0)) resource.input.send(data)
}

function resetInput(resource: Resource, connection: TerminalConnection) {
  if (resource.input !== connection) return
  resource.input = undefined
  resource.failed = true
}

function ended(id: string, resource: Resource) {
  if (resources.get(id) !== resource) return
  release(id, resource)
  void resource.panels.patchView(id, { ended: true }).catch(() => {})
}

listen((directory, event) => {
  if (event.type !== "terminal.exited" && event.type !== "terminal.deleted") return
  for (const [id, resource] of resources)
    if (resource.ptyID === event.payload.id && sameDir(resource.directory, event.payload.directory || directory))
      ended(id, resource)
})

function watch() {
  timer ??= setInterval(() => {
    if (!resources.size) {
      clearInterval(timer)
      timer = undefined
      return
    }
    for (const [key, resource] of resources) {
      if (resource.failed) {
        const tab = resource.panels.state.tabs.find((tab) => tab.id === key)
        if (tab) void terminalFor(tab, resource.directory, resource.panels, resource.sessionID).catch(() => {})
        continue
      }
      if (!resource.ptyID) continue
      void client()
        .then((connection) => connection.terminal.get({ id: resource.ptyID! }))
        .then((info) => {
          if (info.status === "exited") ended(key, resource)
        })
        .catch((error: unknown) => {
          if (codeOf(error) === "MRK-5001") ended(key, resource)
        })
    }
  }, 20_000)
}

/** The stable tab owner exists before a PTY ID, including on the new-conversation page. */
export function terminalFor(tab: PanelTab, directory: string, panels: Panels, sessionID?: string) {
  if (tab.view?.ended) return Promise.resolve(undefined)
  const known = resources.get(tab.id)
  if (known && !known.failed) return known.request
  known?.input?.close()
  const location = tab.ptyDirectory ?? directory
  const resource: Resource = {
    directory: location,
    panels,
    sessionID,
    ptyID: tab.ptyID ?? known?.ptyID,
    queued: known?.queued ?? [],
    request: Promise.resolve({ directory: location, ptyID: "" }),
  }
  resources.set(tab.id, resource)
  watch()
  resource.request = (async () => {
    const connection = await client()
    const info = resource.ptyID
      ? await connection.terminal.get({ id: resource.ptyID }).catch((error: unknown) => {
          if (codeOf(error) === "MRK-5001") return undefined
          throw error
        })
      : await connection.terminal.create({ directory: location, size: { cols: 80, rows: 24 } })
    if (!info || info.status === "exited") {
      ended(tab.id, resource)
      return
    }
    resource.ptyID = info.id
    if (!resource.panels.state.tabs.some((item) => item.id === tab.id)) {
      await connection.terminal.remove({ id: info.id })
      release(tab.id, resource)
      return
    }
    await resource.panels.patch(tab.id, { ptyID: info.id, ptyDirectory: location })
    return { ptyID: info.id, directory: location }
  })()
  void resource.request
    .then((address) => {
      if (address && resources.get(tab.id) === resource) flushInput(resource, address)
    })
    .catch(() => {
      if (resources.get(tab.id) === resource) resource.failed = true
    })
  return resource.request
}

export function promoteTerminal(id: string, panels: Panels, sessionID?: string) {
  const resource = resources.get(id)
  if (!resource) return
  resource.panels = panels
  resource.sessionID = sessionID
  resource.binding = (resource.binding ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const address = await resource.request
      if (!address) return
      const { ptyID } = address
      if (resources.get(id) !== resource || !resource.panels.state.tabs.some((tab) => tab.id === id)) return
      const tab = resource.panels.state.tabs.find((tab) => tab.id === id)
      if (tab && (tab.ptyID !== ptyID || tab.ptyDirectory !== resource.directory))
        await resource.panels.patch(id, { ptyID, ptyDirectory: resource.directory })
    })
    .catch(() => {
      if (resources.get(id) === resource) resource.failed = true
    })
}

export async function stopTerminal(tab: PanelTab) {
  const resource = resources.get(tab.id)
  const pending = await resource?.request.catch(() => undefined)
  const id = tab.ptyID ?? resource?.ptyID ?? pending?.ptyID
  if (id)
    await (await client()).terminal.remove({ id }).catch((error: unknown) => {
      if (codeOf(error) !== "MRK-5001") throw error
    })
  release(tab.id, resource)
}

export async function stopAllTerminals() {
  for (const [id, resource] of [...resources]) await stopTerminal({ kind: "terminal", id, ptyID: resource.ptyID })
}
