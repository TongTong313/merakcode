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
  private pending = new WeakMap<BrowserWindow, Promise<void>>()
  /** Explicitly closed tab IDs stay closed; cache eviction still allows restoration. */
  private closed = new WeakMap<BrowserWindow, Set<string>>()

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
    const publish = (url: string, title: string) => {
      const history = contents.navigationHistory
      this.send(win, "browserState", {
        id,
        url,
        title,
        loading: contents.isLoading(),
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      } satisfies BrowserState)
    }
    let probed = ""
    const state = () => {
      if (contents.isDestroyed()) return
      const url = contents.getURL()
      const title = contents.getTitle()
      publish(url, title)
      // Windows can keep the address as the title after the document title is already available.
      // Probe once per address so title events cannot keep shutdown flush busy forever.
      if (contents.isLoading() || !url || probed === url || (title && title !== url && title !== addressTitle(url)))
        return
      probed = url
      void contents
        .executeJavaScript("document.title")
        .then((value: unknown) => {
          if (contents.isDestroyed() || contents.getURL() !== url) return
          if (typeof value !== "string" || !value || value === title) return
          publish(url, value)
        })
        .catch(() => {})
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

  close(win: BrowserWindow, id: string) {
    return this.enqueue(win, async () => {
      if (!(await this.closePage(win, id))) return false
      const closed = this.closed.get(win) ?? new Set<string>()
      closed.add(id)
      this.closed.set(win, closed)
      return true
    })
  }

  release(win: BrowserWindow, id: string) {
    return this.enqueue(win, () => this.closePage(win, id))
  }

  private async closePage(win: BrowserWindow, id: string, ask = true): Promise<boolean> {
    const pages = this.views.get(win)
    const view = pages?.get(id)
    if (!view || view.webContents.isDestroyed()) {
      pages?.delete(id)
      return true
    }
    const contents = view.webContents
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (closed: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        contents.removeListener("will-prevent-unload", prevented)
        contents.removeListener("destroyed", destroyed)
        if (closed) {
          pages?.delete(id)
          if (!win.isDestroyed()) win.contentView.removeChildView(view)
        }
        resolve(closed)
      }
      const prevented = (event: Electron.Event) => {
        const zh = this.locale() === "zh"
        // Automated runs cannot answer the sync dialog; leaving keeps quit from blocking forever.
        const leave =
          !ask ||
          process.env.MERAKCODE_BROWSER_LEAVE_UNLOAD === "1" ||
          dialog.showMessageBoxSync(win, {
            type: "question",
            message: zh ? "离开此页面？" : "Leave this page?",
            detail: zh ? "页面可能包含尚未保存的输入。" : "The page may contain unsaved input.",
            buttons: zh ? ["留在页面", "离开页面"] : ["Stay", "Leave"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }) === 1
        // preventDefault lets the unload continue. Staying resolves without closing the page.
        if (leave) {
          event.preventDefault()
          return
        }
        finish(false)
      }
      const destroyed = () => finish(true)
      // A guest that never emits destroyed must not keep the window open.
      timer = setTimeout(() => {
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
        finish(true)
      }, 5_000)
      contents.once("will-prevent-unload", prevented)
      contents.once("destroyed", destroyed)
      try {
        contents.close({ waitForBeforeUnload: ask })
      } catch {
        finish(true)
      }
    })
  }

  closeAll(win: BrowserWindow) {
    // Drop a stuck admission chain so quit is not blocked behind a load that never finishes.
    this.pending.set(win, Promise.resolve())
    return this.enqueue(win, async () => {
      for (const id of [...(this.views.get(win)?.keys() ?? [])]) if (!(await this.closePage(win, id))) return false
      return true
    })
  }

  navigate(win: BrowserWindow, id: string, url: string) {
    return this.open(win, id, url, false)
  }

  restore(win: BrowserWindow, id: string, url: string) {
    return this.open(win, id, url, true)
  }

  private open(win: BrowserWindow, id: string, url: string, restore: boolean) {
    const result = this.enqueue(win, async () => {
      if (this.closed.get(win)?.has(id)) return { view: undefined, load: false }
      const load = !restore || !this.views.get(win)?.has(id)
      return { view: await this.navigatePage(win, id, url), load }
    })
    return result.then(async ({ view, load }) => {
      const contents = view?.webContents
      if (!view || !contents || contents.isDestroyed()) return false
      if (load && contents.getURL() !== url) {
        await Promise.race([
          contents.loadURL(url).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ])
      }
      if (!contents.isDestroyed()) this.snapshots.get(view)?.()
      return true
    })
  }

  /** Serialize admission and close, without waiting for page responses. */
  private enqueue<T>(win: BrowserWindow, operation: () => Promise<T>) {
    const result = (this.pending.get(win) ?? Promise.resolve()).then(operation)
    this.pending.set(
      win,
      result.then(
        () => {},
        () => {},
      ),
    )
    return result
  }

  private async navigatePage(win: BrowserWindow, id: string, url: string) {
    if (win.isDestroyed()) return
    if (!web(url)) throw new Error("only http and https pages can be opened")
    const pages = this.views.get(win)
    if (!pages?.has(id) && (pages?.size ?? 0) >= 6) {
      let released = false
      for (const [key, view] of pages ?? []) {
        if (!view.getVisible() && (await this.closePage(win, key, false))) {
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

/** Chromium's fallback title is the address without its scheme. */
function addressTitle(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return ""
  }
}
