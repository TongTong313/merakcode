import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from "electron"
import type { AppLocale, TrayState } from "../../renderer/src/desktop/bridge-contract"

/** System tray: recent sessions, new session, settings, quit, and stopping the background engine with it */
export type Options = {
  icon: string
  locale: () => AppLocale
  state: TrayState | undefined
  open: (href?: string) => void
  newSession: () => void
  settings: () => void
  clear: () => void
  quit: () => void
  /** Stops the engine that keeps running in the background, then quits */
  stopEngine: () => void
}

const text = {
  zh: {
    open: "打开 MerakCode",
    session: "新建会话",
    recent: "最近会话",
    more: "更多",
    clear: "清除通知",
    settings: "设置",
    quit: "退出",
    stopEngine: "停止后台引擎并退出",
  },
  en: {
    open: "Open MerakCode",
    session: "New Session",
    recent: "Recent Sessions",
    more: "More",
    clear: "Clear Notifications",
    settings: "Settings",
    quit: "Quit",
    stopEngine: "Stop Background Engine and Quit",
  },
}

export class AppTray {
  private tray?: Tray
  private state: TrayState
  private image?: NativeImage
  private badge?: NativeImage

  constructor(private options: Options) {
    this.state = options.state ?? { recent: [], more: [], hasNotifications: false }
  }

  start() {
    const image = nativeImage.createFromPath(this.options.icon)
    if (image.isEmpty()) return
    this.image = image.resize({ width: process.platform === "darwin" ? 18 : 16, quality: "best" })
    this.badge = badged(this.image)
    this.tray = new Tray(this.image)
    this.tray.setToolTip("MerakCode")
    // On macOS a click opens the menu; on Windows and Linux a left click opens the window and a right click the menu
    if (process.platform !== "darwin") this.tray.on("click", () => this.options.open())
    this.render()
  }

  update(state: TrayState) {
    this.state = state
    this.render()
  }

  render() {
    if (!this.tray) return
    this.tray.setImage(this.state.hasNotifications ? this.badge! : this.image!)
    const t = text[this.options.locale()]
    const session = (item: TrayState["recent"][number]): MenuItemConstructorOptions => ({
      label: `${item.unseen ? "● " : ""}${item.title}`,
      click: () => this.options.open(item.href),
    })
    const template: MenuItemConstructorOptions[] = [
      { label: t.open, click: () => this.options.open() },
      { label: t.session, click: () => this.options.newSession() },
      ...(this.state.recent.length
        ? [{ type: "separator" as const }, { label: t.recent, enabled: false }, ...this.state.recent.map(session)]
        : []),
      ...(this.state.more.length ? [{ label: t.more, submenu: this.state.more.map(session) }] : []),
      { type: "separator" },
      ...(this.state.hasNotifications ? [{ label: t.clear, click: () => this.options.clear() }] : []),
      { label: t.settings, click: () => this.options.settings() },
      { type: "separator" },
      { label: t.quit, click: () => this.options.quit() },
      { label: t.stopEngine, click: () => this.options.stopEngine() },
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy() {
    this.tray?.destroy()
    this.tray = undefined
  }
}

function badged(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  const pixels = image.toBitmap({ scaleFactor: 1 })
  const center = width - 4
  for (let y = 0; y < 7; y++) {
    for (let x = width - 7; x < width; x++) {
      const distance = Math.hypot(x - center, y - 3)
      if (distance > 3) continue
      const offset = (y * width + x) * 4
      // Neutral colors work with both RGB and BGR byte orders.
      pixels.fill(distance <= 2 ? 255 : 0, offset, offset + 3)
      pixels[offset + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 })
}
