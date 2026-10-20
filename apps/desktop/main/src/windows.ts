import { BrowserWindow, nativeTheme, screen, shell, type WebContents } from "electron"
import type { AppLocale, BackendState } from "../../renderer/src/desktop/bridge-contract"
import { IPC } from "../../renderer/src/desktop/bridge-contract"
import type { Endpoint } from "./backend"
import { Diagnose } from "./diagnose"
import { Route } from "./route"
import type { Settings } from "./settings"

/**
 * Application windows. Each window loads the same UI from the local backend and shows one project (except the home
 * page).
 *
 * - A window only stays on local backend pages; any other URL is handed to the system browser.
 * - window.open from a page in the browser panel navigates inside the panel instead of opening an Electron window.
 * - When the backend moves to a new port (the old one was taken), every window reloads at the new address and keeps
 *   its current page.
 */
export type Options = {
  preload: string
  settings: Settings
  endpoint: () => Endpoint | undefined
  state: () => BackendState
  locale: () => AppLocale
  /** Log directory, shown on the startup failure page */
  logs: string
  /** Why the local service last failed to start */
  error: () => string | undefined
  icon?: string
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
}

const WIDTH = 1280
const HEIGHT = 832

export class Windows {
  private list = new Set<BrowserWindow>()
  /** Windows that could not load while the backend was not ready; loaded once it is */
  private pending = new Map<BrowserWindow, string>()
  private crashes = new WeakMap<BrowserWindow, number[]>()

  constructor(private options: Options) {}

  all() {
    return [...this.list].filter((win) => !win.isDestroyed())
  }

  /** IPC only accepts windows created here */
  owns(contents: WebContents) {
    return this.all().some((win) => win.webContents === contents)
  }

  from(contents: WebContents) {
    return this.all().find((win) => win.webContents === contents)
  }

  /** Most recently used window, for the tray, deep links and system notifications */
  last() {
    return BrowserWindow.getFocusedWindow() ?? this.all().at(-1)
  }

  send(win: BrowserWindow, name: string, ...args: unknown[]) {
    if (!win.isDestroyed()) win.webContents.send(IPC.event, name, ...args)
  }

  broadcast(name: string, ...args: unknown[]) {
    for (const win of this.all()) this.send(win, name, ...args)
  }

  focus(win: BrowserWindow) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /** Opens a project: focuses its existing window (switching to the given session), or creates a new one */
  open(opts: { directory?: string; sessionID?: string } = {}) {
    const existing = opts.directory
      ? this.all().find((win) => {
          const shown = Route.directory(win.webContents.getURL())
          return shown && Route.same(shown, opts.directory!)
        })
      : undefined
    if (existing) {
      this.focus(existing)
      if (opts.sessionID) this.send(existing, "navigate", Route.of(opts))
      return existing
    }
    // Reuse a lone home page window instead of opening another one
    const home = opts.directory
      ? this.all().find((win) => this.all().length === 1 && !Route.directory(win.webContents.getURL()))
      : undefined
    if (home) {
      this.focus(home)
      this.load(home, Route.of(opts))
      return home
    }
    return this.create(Route.of(opts))
  }

  private create(route: string) {
    const saved = this.options.settings.bounds
    const others = this.all()
    // Offset new windows so they do not cover existing ones exactly
    const offset = others.length ? 28 * others.length : 0
    const bounds = visible(
      saved
        ? {
            ...saved,
            x: saved.x === undefined ? undefined : saved.x + offset,
            y: saved.y === undefined ? undefined : saved.y + offset,
          }
        : { width: WIDTH, height: HEIGHT },
    )
    const win = new BrowserWindow({
      ...bounds,
      useContentSize: true,
      minWidth: 800,
      minHeight: 600,
      show: false,
      title: "MerakCode",
      backgroundColor: colors().background,
      autoHideMenuBar: true,
      icon: this.options.icon,
      // Windows draws native caption buttons (Window Controls Overlay) over the right end of the UI top bar, at the
      // same height; macOS and Linux use the native title bar
      ...(process.platform === "win32" ? { titleBarStyle: "hidden" as const, titleBarOverlay: overlay() } : {}),
      webPreferences: {
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    })
    this.list.add(win)
    if (saved?.maximized && !others.length) win.maximize()
    this.harden(win)
    this.track(win)
    win.once("ready-to-show", () => win.show())
    this.load(win, route)
    return win
  }

  /** Loads an in-app route; if the backend is not ready yet, remembers it and loads it later */
  load(win: BrowserWindow, route: string) {
    const endpoint = this.options.endpoint()
    if (!endpoint || this.options.state() !== "ready") {
      this.pending.set(win, route)
      this.placeholder(win)
      return
    }
    this.pending.delete(win)
    win.loadURL(endpoint.url + route).catch((error: Error) => {
      // Interrupted by a newer navigation, not a failure
      if (/ERR_ABORTED/.test(error.message)) return
      this.options.log("warn", "window load failed", { error: error.message })
      this.pending.set(win, route)
    })
  }

  /** Backend is ready: loads waiting windows and moves windows on an old port to the new address, keeping the page */
  ready(endpoint: Endpoint) {
    for (const win of this.all()) {
      const waiting = this.pending.get(win)
      if (waiting !== undefined) {
        this.load(win, waiting)
        continue
      }
      const current = win.webContents.getURL()
      const url = (() => {
        try {
          return new URL(current)
        } catch {
          return
        }
      })()
      if (url && url.origin !== endpoint.origin) this.load(win, url.pathname + url.search + url.hash)
    }
  }

  /** Theme changed: updates the window background and the Windows caption buttons */
  theme() {
    for (const win of this.all()) {
      win.setBackgroundColor(colors().background)
      if (process.platform === "win32") win.setTitleBarOverlay(overlay())
    }
  }

  /** Backend state changed: refreshes the placeholder page in waiting windows */
  waiting() {
    for (const win of this.pending.keys()) if (!win.isDestroyed()) this.placeholder(win)
  }

  /** Placeholder page shown while the backend is not ready (static text only, no capabilities) */
  private placeholder(win: BrowserWindow) {
    const failed = this.options.state() === "failed"
    const zh = this.options.locale() === "zh"
    const title = failed
      ? zh
        ? "本地服务启动失败"
        : "The local service failed to start"
      : zh
        ? "正在启动本地服务…"
        : "Starting the local service…"
    // Known causes (such as a missing system library) get a fix; otherwise suggest retrying and checking the logs
    const hint = failed ? Diagnose.hint(this.options.error(), this.options.locale()) : undefined
    const detail = !failed
      ? ""
      : (hint ? hint + " " : "") +
        (zh
          ? `可以在菜单「帮助 → 重启本地服务」重试。日志在：${this.options.logs}`
          : `Use Help → Restart Local Service to try again. Logs: ${this.options.logs}`)
    const dark = nativeTheme.shouldUseDarkColors
    const escape = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
    const html = `<!doctype html><meta charset="utf-8"><title>MerakCode</title><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;font:14px system-ui,sans-serif;background:${dark ? "#131315" : "#fff"};color:${dark ? "#d4d4d8" : "#52525b"};-webkit-app-region:drag}p{margin:0;max-width:560px;text-align:center;line-height:1.6;-webkit-user-select:text;-webkit-app-region:no-drag}h1{margin:0;font-size:16px;font-weight:600}</style><h1>${escape(title)}</h1>${detail ? `<p>${escape(detail)}</p>` : ""}`
    void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch(() => {})
    if (!win.isVisible()) win.show()
  }

  private harden(win: BrowserWindow) {
    const contents = win.webContents
    const internal = (url: string) => {
      const endpoint = this.options.endpoint()
      try {
        return Boolean(endpoint) && new URL(url).origin === endpoint!.origin
      } catch {
        return false
      }
    }
    const external = (url: string) => {
      try {
        return ["http:", "https:"].includes(new URL(url).protocol)
      } catch {
        return false
      }
    }
    const block = (event: Electron.Event, url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (!mainFrame || internal(url)) return
      event.preventDefault()
      if (external(url)) void shell.openExternal(url)
    }
    contents.on("will-navigate", block)
    contents.on("will-redirect", block)
    contents.setWindowOpenHandler(({ url }) => {
      if (!external(url)) return { action: "deny" }
      // External links open in the system browser (pages in the browser panel are handled in browser.ts)
      void shell.openExternal(url)
      return { action: "deny" }
    })
    contents.on("will-attach-webview", (event) => event.preventDefault())
  }

  private track(win: BrowserWindow) {
    const save = () => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
      const maximized = win.isMaximized()
      const bounds = maximized ? this.options.settings.bounds : { ...win.getContentBounds(), maximized: false }
      if (bounds) this.options.settings.bounds = { ...bounds, maximized }
    }
    const timer = { current: undefined as NodeJS.Timeout | undefined }
    const later = () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(save, 500)
    }
    win.on("resize", later)
    win.on("move", later)
    win.on("maximize", save)
    win.on("unmaximize", save)
    win.on("close", save)
    win.on("closed", () => {
      clearTimeout(timer.current)
      this.list.delete(win)
      this.pending.delete(win)
    })
    win.on("enter-full-screen", () => this.send(win, "fullscreen", true))
    win.on("leave-full-screen", () => this.send(win, "fullscreen", false))

    const contents = win.webContents
    contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      // -3 (ERR_ABORTED) means a newer navigation interrupted the load
      if (!mainFrame || code === -3 || url.startsWith("data:")) return
      this.options.log("warn", "window failed to load", { code, description })
      const parsed = safeUrl(url)
      this.pending.set(win, parsed ? parsed.pathname + parsed.search + parsed.hash : "/")
    })
    // Renderer crashed: reload on the first crash within 10 seconds; on repeated crashes stay on the blank page until
    // the user reloads from the menu
    contents.on("render-process-gone", (_event, details) => {
      this.options.log("error", "renderer gone", { reason: details.reason, exitCode: details.exitCode })
      if (details.reason === "clean-exit") return
      const now = Date.now()
      const recent = (this.crashes.get(win) ?? []).filter((at) => now - at < 10_000)
      recent.push(now)
      this.crashes.set(win, recent)
      if (recent.length > 1) return
      const parsed = safeUrl(contents.getURL())
      this.load(win, parsed ? parsed.pathname + parsed.search + parsed.hash : "/")
    })
  }
}

function safeUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return
  }
}

/** Window background and caption button colors, matching the UI top bar (--bg) */
function colors() {
  const dark = nativeTheme.shouldUseDarkColors
  return { background: dark ? "#131315" : "#ffffff", symbol: dark ? "#a0a0a9" : "#52525b" }
}

const overlay = () => ({ color: colors().background, symbolColor: colors().symbol, height: 44 })

/** Drops the saved position if it is off every display (for example after a monitor change), keeping the size */
function visible(bounds: { x?: number; y?: number; width: number; height: number }) {
  const width = Math.max(800, bounds.width)
  const height = Math.max(600, bounds.height)
  if (bounds.x === undefined || bounds.y === undefined) return { width, height }
  const inside = screen.getAllDisplays().some(({ workArea }) => {
    const x = bounds.x! + 40
    const y = bounds.y! + 20
    return x >= workArea.x && x < workArea.x + workArea.width && y >= workArea.y && y < workArea.y + workArea.height
  })
  return inside ? { x: bounds.x, y: bounds.y, width, height } : { width, height }
}
