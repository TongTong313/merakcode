import { createStore } from "solid-js/store"
import type { BrowserConsole, BrowserState } from "../../desktop/bridge-contract"
import { bridge } from "../../lib/bridge"
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
bridge?.onBrowserState((state) => pages.get(state.id)?.setPage(state))
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

export function releaseBrowserState(id: string) {
  pages.delete(id)
}
