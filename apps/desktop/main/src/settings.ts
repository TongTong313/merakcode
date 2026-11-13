import type { AppLocale, Theme, TrayState } from "../../renderer/src/desktop/bridge-contract"
import type { Storage } from "./storage"

/** Main process settings, stored apart from renderer settings in a bucket of their own */
export class Settings {
  private static BUCKET = "desktop.main"

  constructor(private storage: Storage) {}

  private read<T>(key: string): T | undefined {
    const raw = this.storage.get(Settings.BUCKET, key)
    if (raw === null) return
    try {
      return JSON.parse(raw) as T
    } catch {
      return
    }
  }

  private write(key: string, value: unknown) {
    this.storage.set(Settings.BUCKET, key, JSON.stringify(value))
  }

  /** UI language, Chinese by default */
  get locale(): AppLocale {
    return this.read<string>("locale") === "en" ? "en" : "zh"
  }

  set locale(value: AppLocale) {
    this.write("locale", value)
  }

  /** Theme: follow the system, or always light or dark */
  get theme(): Theme {
    const value = this.read<string>("theme")
    return value === "light" || value === "dark" ? value : "system"
  }

  set theme(value: Theme) {
    this.write("theme", value)
  }

  /** Window position and size when last closed (content area, in DIPs) */
  get bounds() {
    const value = this.read<{ x?: number; y?: number; width: number; height: number; maximized?: boolean }>("bounds")
    if (!value || typeof value.width !== "number" || typeof value.height !== "number") return
    return value
  }

  set bounds(value: { x?: number; y?: number; width: number; height: number; maximized?: boolean } | undefined) {
    this.write("bounds", value)
  }

  /** The engine program the "start at login" item was registered with; unset while the switch is off */
  get loginProgram(): string | undefined {
    const value = this.read<string>("loginProgram")
    return typeof value === "string" && value ? value : undefined
  }

  set loginProgram(value: string | undefined) {
    if (value === undefined) this.storage.remove(Settings.BUCKET, "loginProgram")
    else this.write("loginProgram", value)
  }

  /** Recent sessions in the tray, so they show at the next startup before any window has loaded */
  get tray(): TrayState | undefined {
    return this.read<TrayState>("tray")
  }

  set tray(value: TrayState | undefined) {
    this.write("tray", value)
  }
}
