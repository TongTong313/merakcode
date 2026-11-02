import { BrowserWindow, dialog, shell, WebContentsView } from "electron"
import type { BrowserBounds, BrowserConsole, BrowserState } from "../../renderer/src/desktop/bridge-contract"

/**
 * Browser in the right-hand panel: one WebContentsView per live browser tab, placed over its UI content.
 *
 * - Separate session partition (logins stay apart from the app UI), no preload and sandboxed, so pages cannot reach
 *   the bridge or the local backend token.
 * - Only http and https open; window.open continues inside the panel, and other protocols go to the system.
 * - UI coordinates are CSS pixels and are converted to DIPs when the window is zoomed.
 */
export class BrowserPanel {
  private snapshots = new WeakMap<WebContentsView, () => void>()
  private views = new Map<BrowserWindow, Map<string, WebContentsView>>()
  private navigating = new WeakMap<BrowserWindow, Promise<void>>()

  constructor(
    private send: (win: BrowserWindow, name: string, ...args: unknown[]) => void,
    private locale: () => "en" | "zh" = () => "en",
  ) {}

  private view(win: BrowserWindow, id: string) {
    let pages = this.views.get(win)
    if (!pages) {
      pages = new Map()
      this.views.set(win, pages)
      const owned = pages
      win.once("closed", () => {
        for (const view of owned.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
        this.views.delete(win)
      })
    }
    const existing = pages.get(id)
    if (existing) {
      pages.delete(id)
      pages.set(id, existing)
      return existing
    }
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
    pages.set(id, view)
    const contents = view.webContents
    const state = () => {
      const history = contents.navigationHistory
      this.send(win, "browserState", {
        id,
        url: contents.getURL(),
        title: contents.getTitle(),
        loading: contents.isLoading(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      } satisfies BrowserState)
    }
    this.snapshots.set(view, state)
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
        id,
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
    return view
  }

  show(win: BrowserWindow, id: string, bounds: BrowserBounds) {
    this.hide(win)
    const view = this.views.get(win)?.get(id)
    if (!view) return
    const zoom = win.webContents.getZoomFactor()
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom),
    })
    view.setVisible(true)
    this.snapshots.get(view)?.()
  }

  hide(win: BrowserWindow, id?: string) {
    for (const [key, view] of this.views.get(win) ?? []) if (!id || id === key) view.setVisible(false)
  }

  async close(win: BrowserWindow, id: string, ask = true): Promise<boolean> {
    const pages = this.views.get(win)
    const view = pages?.get(id)
    if (!view || view.webContents.isDestroyed()) {
      pages?.delete(id)
      return true
    }
    const contents = view.webContents
    return new Promise((resolve) => {
      const prevented = (event: Electron.Event) => {
        const zh = this.locale() === "zh"
        if (
          ask &&
          dialog.showMessageBoxSync(win, {
            type: "question",
            message: zh ? "离开此页面？" : "Leave this page?",
            detail: zh ? "页面可能包含尚未保存的输入。" : "The page may contain unsaved input.",
            buttons: zh ? ["留在页面", "离开页面"] : ["Stay", "Leave"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }) === 1
        ) {
          event.preventDefault()
          return
        }
        contents.removeListener("destroyed", destroyed)
        resolve(false)
      }
      const destroyed = () => {
        contents.removeListener("will-prevent-unload", prevented)
        pages?.delete(id)
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        resolve(true)
      }
      contents.once("will-prevent-unload", prevented)
      contents.once("destroyed", destroyed)
      contents.close({ waitForBeforeUnload: true })
    })
  }

  async closeAll(win: BrowserWindow) {
    await this.navigating.get(win)
    for (const id of [...(this.views.get(win)?.keys() ?? [])]) if (!(await this.close(win, id))) return false
    return true
  }

  navigate(win: BrowserWindow, id: string, url: string) {
    const result = (this.navigating.get(win) ?? Promise.resolve()).then(() => this.navigatePage(win, id, url))
    this.navigating.set(
      win,
      result.then(
        () => {},
        () => {},
      ),
    )
    return result.then(async (view) => {
      if (!view || view.webContents.isDestroyed()) return false
      if (view.webContents.getURL() !== url) await view.webContents.loadURL(url).catch(() => {})
      return true
    })
  }

  private async navigatePage(win: BrowserWindow, id: string, url: string) {
    if (win.isDestroyed()) return
    if (!web(url)) throw new Error("only http and https pages can be opened")
    const pages = this.views.get(win)
    if (!pages?.has(id) && (pages?.size ?? 0) >= 6) {
      let released = false
      for (const [key, view] of pages ?? []) {
        if (!view.getVisible() && (await this.close(win, key, false))) {
          released = true
          break
        }
      }
      if (!released) return
    }
    if (win.isDestroyed()) return
    return this.view(win, id)
  }

  back(win: BrowserWindow, id: string) {
    this.views.get(win)?.get(id)?.webContents.navigationHistory.goBack()
  }

  forward(win: BrowserWindow, id: string) {
    this.views.get(win)?.get(id)?.webContents.navigationHistory.goForward()
  }

  reload(win: BrowserWindow, id: string) {
    this.views.get(win)?.get(id)?.webContents.reload()
  }

  devtools(win: BrowserWindow, id: string) {
    this.views.get(win)?.get(id)?.webContents.openDevTools({ mode: "detach" })
  }
}

function web(url: string) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
