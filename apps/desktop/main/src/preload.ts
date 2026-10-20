import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron"
import { IPC, type DesktopBridge } from "../../renderer/src/desktop/bridge-contract"
import type { Invoke } from "./ipc"

/**
 * Bridge between windows and the main process (a sandboxed preload, limited to these electron modules).
 * Every method goes over one IPC channel; the main process checks that the sender is the main frame of one of our
 * windows and that the page comes from the local backend.
 */
type Init = Pick<DesktopBridge, "os" | "version" | "serverUrl">

const init = ipcRenderer.sendSync(IPC.init) as Init | undefined

const call = <K extends Invoke>(method: K) =>
  ((...args: unknown[]) => ipcRenderer.invoke(IPC.invoke, method, ...args)) as unknown as DesktopBridge[K]

const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
ipcRenderer.on(IPC.event, (_event, name: string, ...args: unknown[]) => {
  for (const fn of listeners.get(name) ?? []) fn(...args)
})
const on =
  <F extends (...args: never[]) => void>(name: string) =>
  (fn: F) => {
    const set = listeners.get(name) ?? new Set()
    listeners.set(name, set)
    const listener = fn as unknown as (...args: unknown[]) => void
    set.add(listener)
    return () => set.delete(listener)
  }

const zoom = (factor: number) => {
  const next = Math.min(3, Math.max(0.3, Math.round(factor * 100) / 100))
  webFrame.setZoomFactor(next)
  return Promise.resolve(next)
}

const bridge: DesktopBridge = {
  platform: "desktop",
  os: init?.os ?? "linux",
  version: init?.version ?? "0.0.0",
  serverUrl: init?.serverUrl ?? location.origin,

  getBackendState: call("getBackendState"),
  onBackendState: on("backendState"),
  restartBackend: call("restartBackend"),
  reloadWindow: call("reloadWindow"),

  getLocale: call("getLocale"),
  setLocale: call("setLocale"),

  openWindow: call("openWindow"),
  focusAndNavigate: call("focusAndNavigate"),
  onNavigate: on("navigate"),
  onNavigateNewSession: on("navigateNewSession"),
  onOpenSettings: on("openSettings"),
  onClearNotifications: on("clearNotifications"),
  pushTrayState: (state) => void ipcRenderer.invoke(IPC.invoke, "pushTrayState", state).catch(() => {}),
  onFullscreenChange: on("fullscreen"),
  restoreWindowFocus: call("restoreWindowFocus"),

  getTheme: call("getTheme"),
  setTheme: call("setTheme"),

  browserShow: call("browserShow"),
  browserHide: call("browserHide"),
  browserNavigate: call("browserNavigate"),
  browserBack: call("browserBack"),
  browserForward: call("browserForward"),
  browserReload: call("browserReload"),
  browserDevtools: call("browserDevtools"),
  onBrowserState: on("browserState"),
  onBrowserConsole: on("browserConsole"),

  openExternal: call("openExternal"),
  openPath: call("openPath"),
  checkAppExists: call("checkAppExists"),
  showItemInFolder: call("showItemInFolder"),
  openLogDirectory: call("openLogDirectory"),
  openDirectoryPicker: call("openDirectoryPicker"),
  openFilePicker: call("openFilePicker"),
  saveTextFile: call("saveTextFile"),
  readTextFile: call("readTextFile"),

  readClipboardImage: call("readClipboardImage"),
  readClipboardText: call("readClipboardText"),
  readClipboardFiles: call("readClipboardFiles"),
  writeClipboardText: call("writeClipboardText"),
  // Electron 32 removed File.path, so paths of dropped files can only be read in preload
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ""
    } catch {
      return ""
    }
  },

  storageGet: call("storageGet"),
  storageSet: call("storageSet"),
  storageRemove: call("storageRemove"),
  log: call("log"),

  zoomIn: () => zoom(webFrame.getZoomFactor() + 0.1),
  zoomOut: () => zoom(webFrame.getZoomFactor() - 0.1),
  zoomReset: () => zoom(1),

  checkForUpdates: call("checkForUpdates"),
  onUpdate: on("update"),
  startUpdateDownload: call("startUpdateDownload"),
  installUpdate: call("installUpdate"),
}

// Exposed only to the app's own main frame; a missing init means the main process rejected this window
if (process.isMainFrame && init) contextBridge.exposeInMainWorld("__MERAKCODE_DESKTOP__", bridge)
