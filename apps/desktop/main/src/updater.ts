import { shell } from "electron"
import updater from "electron-updater"
import { ErrorCode } from "@merakcode/util/error-code"
import type { UpdateEvent, UpdateSkipReason } from "../../renderer/src/desktop/bridge-contract"
import { UpdatePolicy } from "./update-policy"

/**
 * Updates from GitHub Releases. A packaged app reads app-update.yml; a development run is given the same GitHub
 * repository so the check can be tried from source. An explicit opt-out skips the server and tells the window why.
 * A new version is announced first and downloaded only when the user asks; once downloaded it installs on restart.
 * Installs that cannot replace themselves (see UpdatePolicy) get a link to the download page instead.
 */
export type Options = {
  /** Set when this process must not contact the update server */
  disabled?: UpdateSkipReason
  /** GitHub Releases to ask when the app is not packaged (there is no app-update.yml yet) */
  feed?: { owner: string; repo: string }
  /** Download page for installs that cannot update themselves */
  releases: string
  version: string
  /** From resources/build-info.json, written when the app is packaged */
  signed: boolean
  broadcast: (name: string, ...args: unknown[]) => void
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
}

export class Updater {
  private version?: string
  private downloaded = false
  private downloading = false
  private checking?: Promise<void>
  private readonly policy: UpdatePolicy.Decision

  constructor(private options: Options) {
    this.policy = UpdatePolicy.decide({
      platform: process.platform,
      appImage: !!process.env.APPIMAGE,
      signed: options.signed,
      version: options.version,
    })
  }

  private send(event: UpdateEvent) {
    this.options.broadcast("update", event)
  }

  private fail(code: string, error: Error) {
    this.options.log("warn", "update failed", { code, error: error.message })
    this.send({ type: "error", code, message: error.message })
  }

  start() {
    if (this.options.disabled) return
    const { autoUpdater } = updater
    // Unpackaged Electron skips the check unless this is set. The feed is the same repository the installer uses.
    if (this.options.feed) {
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.setFeedURL({ provider: "github", owner: this.options.feed.owner, repo: this.options.feed.repo })
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = this.policy.allowPrerelease
    autoUpdater.logger = {
      info: (message?: unknown) => this.options.log("info", String(message)),
      warn: (message?: unknown) => this.options.log("warn", String(message)),
      error: (message?: unknown) => this.options.log("error", String(message)),
      debug: () => {},
    }
    autoUpdater.on("checking-for-update", () => this.send({ type: "checking" }))
    autoUpdater.on("update-not-available", () => this.send({ type: "latest" }))
    autoUpdater.on("update-available", (info) => {
      this.version = info.version
      this.announce()
    })
    autoUpdater.on("download-progress", (progress) => this.send({ type: "progress", percent: progress.percent }))
    autoUpdater.on("update-downloaded", (info) => {
      this.downloaded = true
      this.downloading = false
      this.send({ type: "downloaded", version: info.version })
    })
    autoUpdater.on("error", (error) => {
      const code = this.downloading
        ? ErrorCode.CATALOG.UPDATE_DOWNLOAD_FAILED.code
        : ErrorCode.CATALOG.UPDATE_CHECK_FAILED.code
      this.downloading = false
      this.fail(code, error)
    })
    setTimeout(() => void this.check(), 15_000)
    setInterval(() => void this.check(), 4 * 60 * 60 * 1000).unref()
  }

  private announce() {
    if (!this.version) return
    if (this.downloaded) return this.send({ type: "downloaded", version: this.version })
    if (this.policy.mode === "manual")
      return this.send({ type: "manual", version: this.version, reason: this.policy.reason })
    this.send({ type: "available", version: this.version })
  }

  /** Checks now; when a new version is already known, tells the windows again (a new window missed it) */
  async check() {
    if (this.options.disabled) {
      this.options.log("info", "update check skipped", { reason: this.options.disabled })
      this.send({ type: "unavailable", reason: this.options.disabled })
      return
    }
    if (this.version) return this.announce()
    this.checking ??= updater.autoUpdater
      .checkForUpdates()
      .then(() => {})
      .catch(() => {})
      .finally(() => (this.checking = undefined))
    return this.checking
  }

  async download() {
    if (this.options.disabled || !this.version) return
    if (this.policy.mode === "manual") return void (await shell.openExternal(this.options.releases))
    this.downloading = true
    await updater.autoUpdater.downloadUpdate().catch(() => {})
  }

  install() {
    if (!this.downloaded) return
    try {
      updater.autoUpdater.quitAndInstall()
    } catch (error) {
      this.fail(ErrorCode.CATALOG.UPDATE_INSTALL_FAILED.code, error as Error)
    }
  }
}
