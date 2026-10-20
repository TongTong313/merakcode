import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { AppLocale, DesktopBridge, FileFilter, Theme, TrayState } from "../../renderer/src/desktop/bridge-contract"
import { IPC } from "../../renderer/src/desktop/bridge-contract"
import type { Backend } from "./backend"
import type { BrowserPanel } from "./browser"
import { Log } from "./log"
import type { Settings } from "./settings"
import type { Storage } from "./storage"
import { System } from "./system"
import type { Updater } from "./updater"
import type { Windows } from "./windows"

/** Bridge methods that go over IPC: everything except constants, subscriptions (on*) and what preload does itself */
export type Invoke = Exclude<
  keyof DesktopBridge,
  "platform" | "os" | "version" | "serverUrl" | `on${string}` | "getPathForFile" | "zoomIn" | "zoomOut" | "zoomReset"
>

type Deps = {
  backend: Backend
  windows: Windows
  settings: Settings
  storage: Storage
  updater: Updater
  tray: (state: TrayState) => void
  locale: (locale: AppLocale) => void
  theme: (theme: Theme) => void
  browser: BrowserPanel
  os: DesktopBridge["os"]
  version: string
  logs: string
}

type Context = { event: IpcMainInvokeEvent; win: BrowserWindow }
type Handler = (ctx: Context, ...args: unknown[]) => unknown

const log = Log.create("ipc")

const str = (value: unknown) => (typeof value === "string" ? value : undefined)
const absolute = (value: unknown) => (typeof value === "string" && path.isAbsolute(value) ? value : undefined)
const filters = (value: unknown) =>
  Array.isArray(value)
    ? (value.filter(
        (item) =>
          item &&
          typeof item.name === "string" &&
          Array.isArray(item.extensions) &&
          item.extensions.every((ext: unknown) => typeof ext === "string"),
      ) as FileFilter[])
    : undefined
const options = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

export namespace Ipc {
  export function register(deps: Deps) {
    // Paths chosen in the open dialog can be read once; paths chosen in the save dialog can be written
    const picked = new WeakMap<object, Set<string>>()
    const set = (map: WeakMap<object, Set<string>>, key: object) => {
      const existing = map.get(key)
      if (existing) return existing
      const created = new Set<string>()
      map.set(key, created)
      return created
    }

    const origin = (url: string) => {
      try {
        return new URL(url).origin
      } catch {
        return
      }
    }

    /** Only trusts the main frame of our own windows, with a page served by the local backend */
    const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      const frame = event.senderFrame
      if (!frame || frame !== event.sender.mainFrame || !deps.windows.owns(event.sender)) return false
      const endpoint = deps.backend.endpoint
      return Boolean(endpoint) && origin(frame.url) === endpoint!.origin
    }

    /** Only files the user just picked in the open dialog can be read, and only once */
    const readable = async (contents: object, file: string) =>
      set(picked, contents).delete(file) ? System.readText(file) : null

    const handlers = {
      getBackendState: () => deps.backend.state,
      restartBackend: async () => {
        await deps.backend
          .restart()
          .catch((error: Error) => log.warn("manual restart failed", { error: error.message }))
      },
      reloadWindow: ({ win }) => win.webContents.reload(),

      getLocale: () => deps.settings.locale,
      setLocale: (_ctx, locale) => {
        if (locale === "zh" || locale === "en") deps.locale(locale)
      },

      openWindow: (_ctx, raw) => {
        const opts = options(raw)
        deps.windows.open({ directory: absolute(opts.directory), sessionID: str(opts.sessionID) })
      },
      focusAndNavigate: ({ win }, href) => {
        if (typeof href !== "string" || !href.startsWith("/")) return
        deps.windows.focus(win)
        deps.windows.send(win, "navigate", href)
      },
      pushTrayState: (_ctx, state) => {
        const parsed = tray(state)
        if (parsed) deps.tray(parsed)
      },
      restoreWindowFocus: ({ win }) => {
        win.focus()
        win.webContents.focus()
      },

      getTheme: () => deps.settings.theme,
      setTheme: (_ctx, theme) => {
        if (theme === "system" || theme === "light" || theme === "dark") deps.theme(theme)
      },

      browserShow: ({ win }, raw) => {
        const box = options(raw)
        const values = [box.x, box.y, box.width, box.height]
        if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return
        deps.browser.show(win, {
          x: box.x as number,
          y: box.y as number,
          width: box.width as number,
          height: box.height as number,
        })
      },
      browserHide: ({ win }) => deps.browser.hide(win),
      browserNavigate: ({ win }, url) => (typeof url === "string" ? deps.browser.navigate(win, url) : undefined),
      browserBack: ({ win }) => deps.browser.back(win),
      browserForward: ({ win }) => deps.browser.forward(win),
      browserReload: ({ win }) => deps.browser.reload(win),
      browserDevtools: ({ win }) => deps.browser.devtools(win),

      openExternal: async (_ctx, url) => {
        if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) await shell.openExternal(url)
      },
      openPath: async (_ctx, target, app) => {
        const file = absolute(target)
        if (!file) throw new Error("invalid path")
        if (typeof app === "string" && app) return System.open(file, app)
        const error = await shell.openPath(file)
        if (error) throw new Error(error)
      },
      checkAppExists: (_ctx, app) => (typeof app === "string" && app ? System.exists(app) : false),
      showItemInFolder: (_ctx, target) => {
        const file = absolute(target)
        if (file) shell.showItemInFolder(file)
      },
      openLogDirectory: async () => {
        await mkdir(deps.logs, { recursive: true })
        await shell.openPath(deps.logs)
        return deps.logs
      },
      openDirectoryPicker: async ({ win }, raw) => {
        const opts = options(raw)
        const result = await dialog.showOpenDialog(win, {
          title: str(opts.title),
          properties: ["openDirectory", "createDirectory", ...(opts.multiple ? (["multiSelections"] as const) : [])],
        })
        if (result.canceled) return null
        return opts.multiple ? result.filePaths : (result.filePaths[0] ?? null)
      },
      openFilePicker: async ({ event, win }, raw) => {
        const opts = options(raw)
        const result = await dialog.showOpenDialog(win, {
          title: str(opts.title),
          filters: filters(opts.filters),
          properties: [
            "openFile",
            ...(opts.directories ? (["openDirectory"] as const) : []),
            ...(opts.multiple ? (["multiSelections"] as const) : []),
          ],
        })
        if (result.canceled) return null
        const list = set(picked, event.sender)
        for (const file of result.filePaths) list.add(file)
        return opts.multiple ? result.filePaths : (result.filePaths[0] ?? null)
      },
      saveTextFile: async ({ win }, name, content) => {
        if (typeof content !== "string") return false
        const result = await dialog.showSaveDialog(win, { defaultPath: str(name) || undefined })
        if (result.canceled || !result.filePath) return false
        return System.writeText(result.filePath, content)
      },
      readTextFile: ({ event }, target) => {
        const file = absolute(target)
        return file ? readable(event.sender, file) : null
      },
      readClipboardImage: async () => {
        const item = (await clipboard.read()).find((entry) => entry.types.includes("image/png"))
        if (!item) return null
        return new Uint8Array(await (await item.getType("image/png")).arrayBuffer())
      },
      readClipboardText: () => clipboard.readText(),
      readClipboardFiles: async () => {
        const item = (await clipboard.read()).find((entry) => entry.types.includes("text/uri-list"))
        const uris = item ? await (await item.getType("text/uri-list")).text() : ""
        return System.clipboardFiles(uris, await clipboard.readText().catch(() => ""))
      },
      writeClipboardText: async (_ctx, text) => {
        if (typeof text === "string") await clipboard.writeText(text)
      },

      storageGet: (_ctx, bucket, key) =>
        typeof bucket === "string" && typeof key === "string" ? deps.storage.get(bucket, key) : null,
      storageSet: (_ctx, bucket, key, value) => {
        if (typeof bucket === "string" && typeof key === "string" && typeof value === "string")
          deps.storage.set(bucket, key, value)
      },
      storageRemove: (_ctx, bucket, key) => {
        if (typeof bucket === "string" && typeof key === "string") deps.storage.remove(bucket, key)
      },
      log: (_ctx, level, service, message, extra) => {
        const levels = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" } as const
        if (
          typeof level !== "string" ||
          !(level in levels) ||
          typeof service !== "string" ||
          typeof message !== "string"
        )
          return
        Log.write(
          levels[level as keyof typeof levels],
          `renderer.${service}`,
          message,
          extra && typeof extra === "object" ? (extra as Record<string, unknown>) : undefined,
        )
      },

      checkForUpdates: () => deps.updater.check(),
      startUpdateDownload: () => deps.updater.download(),
      installUpdate: () => deps.updater.install(),
    } satisfies Record<Invoke, Handler>

    ipcMain.handle(IPC.invoke, async (event, method: unknown, ...args: unknown[]) => {
      const handler =
        typeof method === "string" && Object.hasOwn(handlers, method)
          ? (handlers as Record<string, Handler>)[method]
          : undefined
      if (!handler) throw new Error(`unknown method: ${String(method)}`)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !trusted(event)) {
        log.warn("ipc rejected", { method, url: event.senderFrame?.url.slice(0, 200) })
        throw new Error("untrusted sender")
      }
      return handler({ event, win }, ...args)
    })

    ipcMain.on(IPC.init, (event) => {
      event.returnValue = trusted(event)
        ? { os: deps.os, version: deps.version, serverUrl: deps.backend.endpoint!.url }
        : undefined
    })
  }
}

function tray(value: unknown): TrayState | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const items = (list: unknown) =>
    Array.isArray(list)
      ? list
          .filter(
            (item) =>
              item && typeof item.id === "string" && typeof item.title === "string" && typeof item.href === "string",
          )
          .slice(0, 20)
          .map((item) => ({
            id: item.id as string,
            title: (item.title as string).slice(0, 120),
            href: item.href as string,
            unseen: item.unseen === true,
          }))
      : []
  return { recent: items(raw.recent), more: items(raw.more), hasNotifications: raw.hasNotifications === true }
}
