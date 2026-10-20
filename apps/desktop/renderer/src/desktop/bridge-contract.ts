// The single contract for the desktop preload bridge.
//
// The Electron preload (apps/desktop/main/src/preload.ts) implements it, and the renderer maps
// window.__MERAKCODE_DESKTOP__ onto its Platform. Both sides import this file, so a missing method fails typecheck.
//
// Deliberately dependency-free (no @/ alias, no types beyond the DOM) so the main process tsc can import it across
// packages.

export type AppLocale = "zh" | "en"

/** Local backend state: the UI shows "reconnecting" or "retry" for restarting / failed */
export type BackendState = "starting" | "ready" | "restarting" | "failed" | "stopped"

export type FileFilter = { name: string; extensions: string[] }

export type TrayState = {
  recent: { id: string; title: string; href: string; unseen?: boolean }[]
  more: { id: string; title: string; href: string; unseen?: boolean }[]
  hasNotifications: boolean
}

/**
 * Follow the system or force light / dark. The main process sets nativeTheme.themeSource from it, which drives the
 * UI's prefers-color-scheme.
 */
export type Theme = "system" | "light" | "dark"

/** Browser panel position in CSS pixels, relative to the top-left of the window content area */
export type BrowserBounds = { x: number; y: number; width: number; height: number }

export type BrowserState = {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserConsole = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  source: string
  line: number
}

export interface DesktopBridge {
  platform: "desktop"
  os: "windows" | "macos" | "linux"
  version: string
  /** Local backend URL; the window is loaded from it */
  serverUrl: string

  getBackendState(): Promise<BackendState>
  onBackendState(fn: (state: BackendState) => void): () => void
  /** Restarts the local backend by hand (the "retry" button) */
  restartBackend(): Promise<void>
  reloadWindow(): Promise<void>

  /** Native menus and dialogs follow the UI language */
  getLocale(): Promise<AppLocale>
  setLocale(locale: AppLocale): Promise<void>

  /** Opens a project window, or focuses it if the project already has one */
  openWindow(opts?: { directory?: string; sessionID?: string }): Promise<void>
  /** Brings the window to the front, then soft-navigates the UI to href (used by notification clicks) */
  focusAndNavigate(href: string): Promise<void>
  onNavigate(fn: (href: string) => void): () => void
  /** Actions from the tray and the menu */
  onNavigateNewSession(fn: () => void): () => void
  onOpenSettings(fn: (category: string) => void): () => void
  onClearNotifications(fn: () => void): () => void
  /** Recent sessions in the tray menu */
  pushTrayState(state: TrayState): void
  /** macOS fullscreen changes: the traffic-light buttons disappear and the layout reclaims their space */
  onFullscreenChange(fn: (fullscreen: boolean) => void): () => void
  /** Returns focus to the window after a native dialog closes */
  restoreWindowFocus(): Promise<void>

  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>

  // Browser panel: the page lives in a main-process WebContentsView (separate session partition, no preload) laid over
  // the panel area. Call browserHide while the UI shows an overlay (dialog, menu), or the page covers it.
  /** Shows the page at these bounds; if no page has been opened yet, only remembers the bounds */
  browserShow(bounds: BrowserBounds): Promise<void>
  browserHide(): Promise<void>
  browserNavigate(url: string): Promise<void>
  browserBack(): Promise<void>
  browserForward(): Promise<void>
  browserReload(): Promise<void>
  browserDevtools(): Promise<void>
  onBrowserState(fn: (state: BrowserState) => void): () => void
  onBrowserConsole(fn: (entry: BrowserConsole) => void): () => void

  openExternal(url: string): Promise<void>
  /** Opens with the system default app, or with a given editor / terminal (see the renderer's editor list for app) */
  openPath(path: string, app?: string): Promise<void>
  /** Whether the given editor / terminal is installed */
  checkAppExists(app: string): Promise<boolean>
  showItemInFolder(path: string): Promise<void>
  openLogDirectory(): Promise<string>
  openDirectoryPicker(opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>
  openFilePicker(opts?: {
    title?: string
    multiple?: boolean
    directories?: boolean
    filters?: FileFilter[]
  }): Promise<string | string[] | null>
  saveTextFile(name: string, content: string): Promise<boolean>
  /** Reads a file just chosen in the file picker (valid for one read); any other path returns null */
  readTextFile(path: string): Promise<string | null>

  readClipboardImage(): Promise<Uint8Array | null>
  readClipboardText(): Promise<string>
  /** Local file paths copied to the clipboard */
  readClipboardFiles(): Promise<string[]>
  writeClipboardText(text: string): Promise<void>
  /** Local path of a dropped File (File.path is gone since Electron 32); empty string for files not on disk */
  getPathForFile(file: File): string

  /** Settings and other persisted data live in the app data directory, so they survive backend port changes */
  storageGet(bucket: string, key: string): Promise<string | null>
  storageSet(bucket: string, key: string, value: string): Promise<void>
  storageRemove(bucket: string, key: string): Promise<void>
  log(
    level: "debug" | "info" | "warn" | "error",
    service: string,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void>

  zoomIn(): Promise<number>
  zoomOut(): Promise<number>
  zoomReset(): Promise<number>

  checkForUpdates(): Promise<void>
  onUpdate(fn: (event: UpdateEvent) => void): () => void
  /** Downloads the update, or opens the download page when this install cannot update itself */
  startUpdateDownload(): Promise<void>
  installUpdate(): Promise<void>
}

/** What the updater is doing (main process → window); features/update/state.ts turns these into one state */
export type UpdateEvent =
  | { type: "checking" }
  | { type: "latest" }
  | { type: "available"; version: string }
  /** A .deb install or an unsigned Mac app cannot update itself: send people to the download page */
  | { type: "manual"; version: string; reason?: "linux-package" | "mac-unsigned" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; code: string; message: string }

/** IPC channel names between the main process and the preload */
export const IPC = {
  invoke: "merakcode:invoke",
  event: "merakcode:event",
  init: "merakcode:init",
} as const
