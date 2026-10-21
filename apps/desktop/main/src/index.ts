import { resolveLogRoot } from "@merakcode/log/node"
import { Paths } from "@merakcode/util/paths"
import { Project } from "@merakcode/util/project"
import { app, dialog, nativeTheme, session, shell } from "electron"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Auth } from "./auth"
import { Backend } from "./backend"
import { BrowserPanel } from "./browser"
import { exportDiagnostics } from "./diagnostics"
import { Engine } from "./engine"
import { Ipc } from "./ipc"
import { Log } from "./log"
import { AppMenu, type Actions } from "./menu"
import { Route } from "./route"
import { Settings } from "./settings"
import { Storage } from "./storage"
import { AppTray } from "./tray"
import { Updater } from "./updater"
import { Windows } from "./windows"

const dev = !app.isPackaged
const here = import.meta.dirname

app.setName("MerakCode")
// Under clients/ of the MerakCode root. Development builds use their own directory so they do not mix with an installed
// release; an explicit --user-data-dir (used by tests) wins
if (!app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", path.join(Paths.clients, dev ? "desktop-dev" : "desktop"))
if (process.platform === "win32") app.setAppUserModelId(dev ? "dev.merakcode.desktop.dev" : "dev.merakcode.desktop")

// Linux: recent Electron defaults to Wayland, where Chinese input methods are unreliable on many distributions, so
// prefer X11 (including XWayland) when available. Leave it alone if the user passed --ozone-platform or the session is
// pure Wayland.
if (process.platform === "linux") {
  const explicit = process.argv.some((arg) => arg === "--ozone-platform" || arg.startsWith("--ozone-platform="))
  const pureWayland = process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" && !process.env.DISPLAY
  if (!explicit && !pureWayland) app.commandLine.appendSwitch("ozone-platform", "x11")
}

/** Project to open at startup (deep link merakcode://open-project?directory=...) */
const requested = (argv: string[]) => argv.map(Route.deepLink).find(Boolean)
let pending = requested(process.argv)
let ready: ((directory?: string) => void) | undefined

if (!app.requestSingleInstanceLock()) app.quit()
else start()

function start() {
  if (!dev) app.setAsDefaultProtocolClient("merakcode")
  app.on("second-instance", (_event, argv) => ready?.(requested(argv)))
  app.on("open-url", (event, url) => {
    event.preventDefault()
    const directory = Route.deepLink(url)
    if (ready) ready(directory)
    else pending = directory
  })
  app.whenReady().then(main)
}

function main() {
  Log.init({ dev })
  const log = Log.create("main")
  const resources = process.resourcesPath
  const userData = app.getPath("userData")
  const storage = new Storage(path.join(userData, "storage"))
  const settings = new Settings(storage)
  nativeTheme.themeSource = settings.theme
  const layout = Engine.layout({ packaged: app.isPackaged, resources, here, env: process.env })
  const missing = Engine.missing(layout, resources, process.env)
  if (missing.length) {
    log.error("engine files missing", { missing })
    dialog.showErrorBox(
      "MerakCode",
      `${settings.locale === "zh" ? "安装不完整，缺少文件" : "The installation is incomplete. Missing"}:\n${missing.join("\n")}`,
    )
    app.quit()
    return
  }
  const logs = Log.directory(dev)
  const icon = dev ? path.join(here, "..", "..", "build", "icon.png") : path.join(resources, "icon.png")
  log.info("starting", { version: app.getVersion(), dev, platform: process.platform, engine: layout.kind })

  const backend = new Backend({
    executable: Engine.command(layout),
    env: () => ({ MERAKCODE_APP_DIST: Engine.appDist(layout, resources) }),
    cwd: homedir(),
    log: (level, message, extra) =>
      Log.write(level === "info" ? "INFO" : level === "warn" ? "WARN" : "ERROR", "backend", message, extra),
  })
  const windows = new Windows({
    preload: path.join(here, "preload.cjs"),
    settings,
    endpoint: () => backend.endpoint,
    state: () => backend.state,
    locale: () => settings.locale,
    logs,
    error: () => backend.error,
    icon: process.platform === "linux" ? icon : undefined,
    log: (level, message, extra) =>
      Log.write(level === "info" ? "INFO" : level === "warn" ? "WARN" : "ERROR", "windows", message, extra),
  })
  const updater = new Updater({
    enabled: !dev && !process.env.MERAKCODE_DISABLE_AUTOUPDATE,
    releases: Project.RELEASES,
    version: app.getVersion(),
    signed: (() => {
      try {
        return JSON.parse(readFileSync(path.join(resources, "build-info.json"), "utf8")).signed === true
      } catch {
        return false
      }
    })(),
    broadcast: (name, ...args) => windows.broadcast(name, ...args),
    log: (level, message, extra) =>
      Log.write(level === "info" ? "INFO" : level === "warn" ? "WARN" : "ERROR", "updater", message, extra),
  })

  const focused = () => {
    const win = windows.last()
    if (win) windows.focus(win)
    return win ?? windows.open()
  }
  const tray = new AppTray({
    icon,
    locale: () => settings.locale,
    state: settings.tray,
    open: (href) => {
      const win = focused()
      if (href) windows.send(win, "navigate", href)
    },
    newSession: () => windows.send(focused(), "navigateNewSession"),
    settings: () => windows.send(focused(), "openSettings", "general"),
    clear: () => windows.broadcast("clearNotifications"),
    quit: () => app.quit(),
  })

  const actions: Actions = {
    newWindow: () => windows.open(),
    openFolder: async () => {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
      if (!result.canceled && result.filePaths[0]) windows.open({ directory: result.filePaths[0] })
    },
    settings: () => windows.send(focused(), "openSettings", "general"),
    checkUpdates: () => void updater.check(),
    restartBackend: () => void backend.restart().catch(() => {}),
    logs: () => void shell.openPath(logs),
    diagnostics: () =>
      void exportDiagnostics({
        root: resolveLogRoot(),
        dir: app.getPath("downloads"),
        info: {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          backend: backend.state,
          error: backend.error,
        },
      }).then(
        (file) => shell.showItemInFolder(file),
        (error: Error) => {
          log.error("export diagnostics failed", { error })
          dialog.showErrorBox("MerakCode", error.message)
        },
      ),
    homepage: () => void shell.openExternal(Project.HOMEPAGE),
    issues: () => void shell.openExternal(Project.ISSUES),
    about: () => {
      const zh = settings.locale === "zh"
      void dialog.showMessageBox({
        type: "info",
        title: "MerakCode",
        message: `MerakCode ${app.getVersion()}`,
        detail: [`Electron ${process.versions.electron}`, `Chromium ${process.versions.chrome}`, Project.HOMEPAGE].join(
          "\n",
        ),
        buttons: [zh ? "好" : "OK"],
        noLink: true,
      })
    },
  }

  const browser = new BrowserPanel((win, name, ...args) => windows.send(win, name, ...args))

  Auth.install(session.defaultSession, () => backend.endpoint)
  // Grant only notifications, clipboard writes and fullscreen; deny everything else (camera, location, ...)
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(["notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission)),
  )
  Ipc.register({
    backend,
    windows,
    settings,
    storage,
    updater,
    tray: (state) => {
      settings.tray = state
      tray.update(state)
    },
    locale: (locale) => {
      settings.locale = locale
      AppMenu.apply(locale, actions)
      tray.render()
    },
    theme: (theme) => {
      settings.theme = theme
      nativeTheme.themeSource = theme
    },
    browser,
    os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    version: app.getVersion(),
    logs,
  })
  AppMenu.apply(settings.locale, actions)
  tray.start()

  let origin: string | undefined
  backend.on("state", (state, endpoint) => {
    windows.broadcast("backendState", state)
    if (state !== "ready" || !endpoint) return windows.waiting()
    windows.ready(endpoint)
    const first = origin === undefined
    const moved = !first && origin !== endpoint.origin
    origin = endpoint.origin
    if (moved) log.info("backend moved", { port: endpoint.port })
  })
  nativeTheme.on("updated", () => windows.theme())

  ready = (directory) => (directory ? windows.open({ directory }) : focused())
  windows.open(pending ? { directory: pending } : {})
  pending = undefined
  void backend.start().catch((error: Error) => log.error("backend failed to start", { error: error.message }))
  updater.start()

  app.on("activate", () => {
    if (!windows.all().length) windows.open()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
  // script/dev.ts restarts the app when the main process is rebuilt, and the backend when engine sources change
  if (dev && process.send)
    process.on("message", (message) => {
      if (message === "quit") app.quit()
      if (message === "restart-backend") void backend.restart().catch(() => {})
    })
  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    tray.destroy()
    void Promise.allSettled([backend.stop()])
      .then(() => Log.close())
      .finally(() => app.exit(0))
  })
}
