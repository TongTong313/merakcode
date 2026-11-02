import { t } from "../../i18n"
import { call, client } from "../../state/client"
import type { PanelTab, Panels } from "../panel/state"

type Address = { directory: string; ptyID: string }
type Resource = {
  directory: string
  sessionID?: string
  ownerSessionID?: string
  panels: Panels
  request: Promise<Address>
  binding?: Promise<void>
  ptyID?: string
}
const resources = new Map<string, Resource>()
let timer: ReturnType<typeof setInterval> | undefined

function watch() {
  timer ??= setInterval(() => {
    if (!resources.size) {
      clearInterval(timer)
      timer = undefined
      return
    }
    for (const [key, resource] of resources) {
      if (!resource.ptyID) continue
      void client(resource.directory)
        .pty.update({ ptyID: resource.ptyID })
        .then((result) => {
          if (result.response?.status === 404 || result.data?.status === "exited") resources.delete(key)
        })
        .catch(() => {})
    }
  }, 20_000)
}

/** The stable tab owner exists before a PTY ID, including on the new-conversation page. */
export function terminalFor(tab: PanelTab, directory: string, panels: Panels, sessionID?: string) {
  const known = resources.get(tab.id)
  if (known) return known.request
  const location = tab.ptyDirectory ?? directory
  const resource: Resource = {
    directory: location,
    panels,
    sessionID,
    request: Promise.resolve({ directory: location, ptyID: "" }),
  }
  resources.set(tab.id, resource)
  watch()
  resource.request = (async () => {
    const c = client(location)
    const owner = { tabID: tab.id, ...(sessionID ? { sessionID } : {}) }
    const info = tab.ptyID
      ? await call(c.pty.get({ ptyID: tab.ptyID }))
      : await call(c.pty.create({ cwd: location, owner }))
    resource.ptyID = info.id
    if (info.owner?.tabID !== tab.id) throw new Error(t("panel.terminalEnded"))
    resource.ownerSessionID = info.owner.sessionID
    if (!resource.panels.state.tabs.some((item) => item.id === tab.id)) {
      await call(c.pty.closeOwned({ owner }))
      throw new Error(t("panel.terminalEnded"))
    }
    if (resource.ownerSessionID !== resource.sessionID) {
      await call(c.pty.update({ ptyID: info.id, owner: { tabID: tab.id, sessionID: resource.sessionID } }))
      resource.ownerSessionID = resource.sessionID
    }
    await resource.panels.patch(tab.id, { ptyID: info.id, ptyDirectory: location })
    return { ptyID: info.id, directory: location }
  })()
  void resource.request.catch(async () => {
    try {
      await call(client(location).pty.closeOwned({ owner: { tabID: tab.id } }))
      resources.delete(tab.id)
    } catch {}
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
      const { ptyID } = await resource.request
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
    .catch(async () => {
      await stopTerminal({ id, kind: "terminal" }, resource.directory).catch(() => {})
    })
}

export async function stopTerminal(tab: PanelTab, directory: string, sessionID?: string) {
  const resource = resources.get(tab.id)
  const c = client(resource?.directory ?? tab.ptyDirectory ?? directory)
  await call(c.pty.closeOwned({ owner: { tabID: tab.id, ...(sessionID ? { sessionID } : {}) } }))
  if (tab.ptyID) await call(c.pty.remove({ ptyID: tab.ptyID }))
  resources.delete(tab.id)
}

export async function stopAllTerminals() {
  for (const [id, resource] of [...resources])
    await stopTerminal({ kind: "terminal", id, ptyID: resource.ptyID }, resource.directory, resource.sessionID)
}
