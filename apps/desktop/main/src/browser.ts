import { BrowserWindow, shell, WebContentsView } from "electron"
import type { BrowserBounds, BrowserConsole, BrowserState } from "../../renderer/src/desktop/bridge-contract"

/**
 * Browser in the right-hand panel: one WebContentsView per window, placed over the browser tab in the UI.
 *
 * - Separate session partition (logins stay apart from the app UI), no preload and sandboxed, so pages cannot reach
 *   the bridge or the local backend token.
 * - Only http and https open; window.open continues inside the panel, and other protocols go to the system.
 * - UI coordinates are CSS pixels and are converted to DIPs when the window is zoomed.
 */
export class BrowserPanel {
  private views = new Map<BrowserWindow, WebContentsView>()

  constructor(private send: (win: BrowserWindow, name: string, ...args: unknown[]) => void) {}

  private view(win: BrowserWindow) {
    const existing = this.views.get(win)
    if (existing) return existing
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:merakcode-browser",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    view.setVisible(false)
    win.contentView.addChildView(view)
    this.views.set(win, view)
    const contents = view.webContents
    const state = () => {
      const history = contents.navigationHistory
      this.send(win, "browserState", {
        url: contents.getURL(),
        title: contents.getTitle(),
        loading: contents.isLoading(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      } satisfies BrowserState)
    }
    for (const name of [
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
      "did-start-loading",
      "did-stop-loading",
    ] as const)
      contents.on(name as "did-navigate", state)
    contents.on("console-message", (event) => {
      const detail = event as unknown as { level: string; message: string; lineNumber: number; sourceId: string }
      const level = detail.level === "warning" ? "warn" : detail.level
      this.send(win, "browserConsole", {
        level: (["debug", "info", "warn", "error"].includes(level) ? level : "info") as BrowserConsole["level"],
        message: String(detail.message).slice(0, 4000),
        source: detail.sourceId ?? "",
        line: detail.lineNumber ?? 0,
      } satisfies BrowserConsole)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (web(url)) void contents.loadURL(url)
      else void shell.openExternal(url).catch(() => {})
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      if (!web(url)) event.preventDefault()
    })
    win.once("closed", () => {
      this.views.delete(win)
      if (!contents.isDestroyed()) contents.close()
    })
    return view
  }

  show(win: BrowserWindow, bounds: BrowserBounds) {
    const view = this.view(win)
    const zoom = win.webContents.getZoomFactor()
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom),
    })
    view.setVisible(true)
  }

  hide(win: BrowserWindow) {
    this.views.get(win)?.setVisible(false)
  }

  async navigate(win: BrowserWindow, url: string) {
    if (!web(url)) throw new Error("only http and https pages can be opened")
    // Load failures (unreachable, interrupted by a newer navigation) show Chromium's error page, so do not throw
    await this.view(win)
      .webContents.loadURL(url)
      .catch(() => {})
  }

  back(win: BrowserWindow) {
    this.views.get(win)?.webContents.navigationHistory.goBack()
  }

  forward(win: BrowserWindow) {
    this.views.get(win)?.webContents.navigationHistory.goForward()
  }

  reload(win: BrowserWindow) {
    this.views.get(win)?.webContents.reload()
  }

  devtools(win: BrowserWindow) {
    this.views.get(win)?.webContents.openDevTools({ mode: "detach" })
  }
}

function web(url: string) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
