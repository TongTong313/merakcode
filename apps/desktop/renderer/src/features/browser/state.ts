import { createStore } from "solid-js/store"
import type { BrowserConsole, BrowserState } from "../../desktop/bridge-contract"
import { bridge } from "../../lib/bridge"
import { persistent } from "../../lib/persistence"
import type { PanelTab } from "../panel/state"

function createPage(tab: PanelTab) {
  const [page, setPage] = createStore<BrowserState>({
    id: tab.id,
    url: tab.url ?? "",
    title: tab.title ?? "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [logs, setLogs] = createStore<BrowserConsole[]>([])
  return { page, setPage, logs, setLogs }
}
const pages = new Map<string, ReturnType<typeof createPage>>()
type Writer = (state: BrowserState, active: () => boolean) => Promise<void>
const writers = new Map<string, Writer>()
const latest = new Map<string, BrowserState>()
const ownerChanges = new Map<string, string | undefined>()
const ownerWrites = new Map<string, Promise<void>>()

export function writeBrowserOwner(id: string, value?: string) {
  ownerChanges.set(id, value)
  const known = ownerWrites.get(id)
  if (known) return known
  const request = Promise.resolve().then(async () => {
    try {
      while (ownerChanges.has(id)) {
        const value = ownerChanges.get(id)
        if (value === undefined) await persistent.remove("browser-owners", id)
        else await persistent.set("browser-owners", id, value)
        if (ownerChanges.get(id) === value) ownerChanges.delete(id)
      }
    } finally {
      ownerWrites.delete(id)
    }
  })
  ownerWrites.set(id, request)
  return request
}

export async function flushBrowserOwners() {
  while (ownerChanges.size) await Promise.all([...ownerChanges].map(([id, value]) => writeBrowserOwner(id, value)))
}
const released = new Set<string>()
let restore: Writer | undefined
export function restoreBrowserOwners(write: Writer) {
  restore = write
}
bridge?.onBrowserState((state) => {
  if (!released.has(state.id)) latest.set(state.id, state)
  pages.get(state.id)?.setPage(state)
  const write = writers.get(state.id)
  if (write) void write(state, () => writers.get(state.id) === write).catch(() => {})
  else if (!released.has(state.id)) void restore?.(state, () => !released.has(state.id)).catch(() => {})
})
bridge?.onBrowserConsole((entry) => pages.get(entry.id)?.setLogs((logs) => [...logs.slice(-199), entry]))

/** Match the native page budget; inactive console snapshots cannot accumulate without a bound. */
export function browserState(tab: PanelTab) {
  const known = pages.get(tab.id)
  if (known) {
    pages.delete(tab.id)
    pages.set(tab.id, known)
    return known
  }
  if (pages.size >= 6) pages.delete(pages.keys().next().value!)
  const created = createPage(tab)
  pages.set(tab.id, created)
  return created
}

export async function releaseBrowserState(id: string) {
  released.add(id)
  writers.delete(id)
  pages.delete(id)
  latest.delete(id)
  await writeBrowserOwner(id)
  if (released.size > 256) released.delete(released.values().next().value!)
}

export function retainBrowserState(id: string, write: Writer) {
  released.delete(id)
  writers.set(id, write)
  const state = latest.get(id)
  if (state) void write(state, () => writers.get(id) === write).catch(() => {})
}
