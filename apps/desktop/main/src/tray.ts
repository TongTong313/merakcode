import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron"
import type { AppLocale, TrayState } from "../../renderer/src/desktop/bridge-contract"

/** System tray: recent sessions, new session, settings, quit */
export type Options = {
  icon: string
  locale: () => AppLocale
  state: TrayState | undefined
  open: (href?: string) => void
  newSession: () => void
  settings: () => void
  clear: () => void
  quit: () => void
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
  },
  en: {
    open: "Open MerakCode",
    session: "New Session",
    recent: "Recent Sessions",
    more: "More",
    clear: "Clear Notifications",
    settings: "Settings",
    quit: "Quit",
  },
}

export class AppTray {
  private tray?: Tray
  private state: TrayState

  constructor(private options: Options) {
    this.state = options.state ?? { recent: [], more: [], hasNotifications: false }
  }

  start() {
    const image = nativeImage.createFromPath(this.options.icon)
    if (image.isEmpty()) return
    this.tray = new Tray(image.resize({ width: process.platform === "darwin" ? 18 : 16, quality: "best" }))
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
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy() {
    this.tray?.destroy()
    this.tray = undefined
  }
}
