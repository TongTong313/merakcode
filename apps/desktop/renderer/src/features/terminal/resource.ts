import { call, client } from "../../state/client"
import { sameDir } from "../../lib/route"
import { listen } from "../../state/store"
import type { PanelTab, Panels } from "../panel/state"

type Address = { directory: string; ptyID: string }
type Resource = {
  directory: string
  sessionID?: string
  ownerSessionID?: string
  panels: Panels
  request: Promise<Address | undefined>
  binding?: Promise<void>
  ptyID?: string
  failed?: boolean
}
const resources = new Map<string, Resource>()
let timer: ReturnType<typeof setInterval> | undefined

function release(id: string, resource?: Resource) {
  if (resource && resources.get(id) !== resource) return
  resources.delete(id)
  if (resources.size) return
  clearInterval(timer)
  timer = undefined
}

function ended(id: string, resource: Resource) {
  if (resources.get(id) !== resource) return
  release(id, resource)
  void resource.panels.patchView(id, { ended: true }).catch(() => {})
}

listen((directory, event) => {
  if (event.type !== "pty.exited" && event.type !== "pty.deleted") return
  for (const [id, resource] of resources)
    if (resource.ptyID === event.properties.id && sameDir(resource.directory, directory)) ended(id, resource)
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
      void client(resource.directory)
        .pty.update({ ptyID: resource.ptyID })
        .then((result) => {
          if (result.response?.status === 404 || result.data?.status === "exited") ended(key, resource)
        })
        .catch(() => {})
    }
  }, 20_000)
}

/** The stable tab owner exists before a PTY ID, including on the new-conversation page. */
export function terminalFor(tab: PanelTab, directory: string, panels: Panels, sessionID?: string) {
  if (tab.view?.ended) return Promise.resolve(undefined)
  const known = resources.get(tab.id)
  if (known && !known.failed) return known.request
  const location = tab.ptyDirectory ?? directory
  const resource: Resource = {
    directory: location,
    panels,
    sessionID,
    ptyID: tab.ptyID,
    request: Promise.resolve({ directory: location, ptyID: "" }),
  }
  resources.set(tab.id, resource)
  watch()
  resource.request = (async () => {
    const c = client(location)
    const owner = { tabID: tab.id, ...(sessionID ? { sessionID } : {}) }
    const result = tab.ptyID ? await c.pty.get({ ptyID: tab.ptyID }) : await c.pty.create({ cwd: location, owner })
    if (result.response?.status === 404) {
      ended(tab.id, resource)
      return
    }
    const info = await call(Promise.resolve(result))
    resource.ptyID = info.id
    if (info.owner?.tabID !== tab.id) {
      ended(tab.id, resource)
      return
    }
    resource.ownerSessionID = info.owner.sessionID
    if (!resource.panels.state.tabs.some((item) => item.id === tab.id)) {
      await call(c.pty.closeOwned({ owner }))
      release(tab.id, resource)
      return
    }
    if (resource.ownerSessionID !== resource.sessionID) {
      await call(c.pty.update({ ptyID: info.id, owner: { tabID: tab.id, sessionID: resource.sessionID } }))
      resource.ownerSessionID = resource.sessionID
    }
    await resource.panels.patch(tab.id, { ptyID: info.id, ptyDirectory: location })
    return { ptyID: info.id, directory: location }
  })()
  void resource.request.catch(() => {
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
      const target = resource.sessionID
      if (resource.ownerSessionID !== target) {
        await call(client(resource.directory).pty.update({ ptyID, owner: { tabID: id, sessionID: target } }))
        resource.ownerSessionID = target
      }
      const tab = resource.panels.state.tabs.find((tab) => tab.id === id)
      if (tab && (tab.ptyID !== ptyID || tab.ptyDirectory !== resource.directory))
        await resource.panels.patch(id, { ptyID, ptyDirectory: resource.directory })
    })
    .catch(() => {
      if (resources.get(id) === resource) resource.failed = true
    })
}

export async function stopTerminal(tab: PanelTab, directory: string) {
  const resource = resources.get(tab.id)
  const c = client(resource?.directory ?? tab.ptyDirectory ?? directory)
  await call(c.pty.closeOwned({ owner: { tabID: tab.id } }))
  if (tab.ptyID) await call(c.pty.remove({ ptyID: tab.ptyID }))
  release(tab.id, resource)
}

export async function stopAllTerminals() {
  for (const [id, resource] of [...resources])
    await stopTerminal({ kind: "terminal", id, ptyID: resource.ptyID }, resource.directory)
}
