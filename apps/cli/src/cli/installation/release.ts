import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync, readlinkSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Project } from "@merakcode/util/project"
import { withTrustedTls } from "@merakcode/util/tls"
import { Log } from "@merakcode/log/logger"
import { I18n } from "../i18n"

/**
 * Directory layout and upgrades for install-script installs (GitHub Releases archives). Must match script/install/:
 *
 *   <home>/versions/<version>/  extracted release (bin/ node/ lib/)
 *   <bin>/merak                 command pointing at the current version (symlink on Unix, forwarding .cmd on Windows)
 *
 * home defaults to ~/.merakcode on Unix and %LOCALAPPDATA%\merakcode on Windows; bin defaults to ~/.local/bin on Unix
 * and <home>\bin on Windows. Upgrading downloads the new version directory and repoints the command; only the current
 * and previous versions are kept, so the command can be pointed back if something goes wrong.
 */
export namespace Release {
  const log = Log.create({ service: "installation.release" })

  export const commands = ["merak"] as const
  export type Layout = { home: string; bin: string }

  export function layout(): Layout {
    const home =
      process.env.MERAKCODE_INSTALL_DIR ||
      (process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "merakcode")
        : path.join(os.homedir(), ".merakcode"))
    const bin =
      process.env.MERAKCODE_BIN_DIR ||
      (process.platform === "win32" ? path.join(home, "bin") : path.join(os.homedir(), ".local", "bin"))
    return { home, bin }
  }

  /** Platform part of the release archive name; Windows is spelled "windows". */
  export function platform() {
    return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  }

  export function extension() {
    return process.platform === "win32" ? "zip" : "tar.gz"
  }

  export function command(layout: Layout, name: (typeof commands)[number]) {
    return path.join(layout.bin, process.platform === "win32" ? `${name}.cmd` : name)
  }

  /** Whether the running copy lives under versions/, i.e. was installed by the install script. */
  export function installed(file: string, layout = Release.layout()) {
    const versions = path.resolve(layout.home, "versions") + path.sep
    const target = path.resolve(file)
    return process.platform === "win32"
      ? target.toLowerCase().startsWith(versions.toLowerCase())
      : target.startsWith(versions)
  }

  /** Version the command currently points at. */
  export function current(layout = Release.layout()) {
    const file = command(layout, "merak")
    if (!existsSync(file)) return
    const target = process.platform === "win32" ? readFileSync(file, "utf8") : readlinkSync(file)
    return target.match(/versions[\\/]([^\\/"]+)[\\/]bin/)?.[1]
  }

  /**
   * Installs `version` and points the command at it. `base` is the URL holding the archives and SHA256SUMS, by default
   * the v<version> download directory on GitHub Releases; MERAKCODE_DOWNLOAD_BASE overrides it (e.g. a mirror).
   */
  export async function install(
    version: string,
    options: { base?: string; layout?: Layout; signal?: AbortSignal } = {},
  ) {
    const layout = options.layout ?? Release.layout()
    const base = (
      options.base ??
      process.env.MERAKCODE_DOWNLOAD_BASE ??
      `https://github.com/${Project.REPOSITORY}/releases/download/v${version}`
    ).replace(/\/$/, "")
    const name = `merakcode-${version}-${platform()}`
    const file = `${name}.${extension()}`
    const versions = path.join(layout.home, "versions")
    // The version before the upgrade becomes the kept "previous" version.
    const previous = current(layout)
    await fs.mkdir(versions, { recursive: true })
    const work = await fs.mkdtemp(path.join(layout.home, ".download-"))
    try {
      log.info("download started", { version, file })
      const sums = await get(`${base}/SHA256SUMS`, options.signal).then((res) => res.text())
      const expected = sums
        .split("\n")
        .find((line) => line.trim().endsWith(`  ${file}`))
        ?.split(/\s+/)[0]
      if (!expected) throw new Error(I18n.t("cli.upgrade.notInSums", { file }))
      const archive = path.join(work, file)
      await fs.writeFile(archive, Buffer.from(await (await get(`${base}/${file}`, options.signal)).arrayBuffer()))
      if ((await sha256(archive)) !== expected) throw new Error(I18n.t("cli.upgrade.checksumMismatch", { file }))
      // The system tar extracts tar.gz; the tar.exe (bsdtar) bundled since Windows 10 also extracts zip.
      const tar =
        process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar"
      execFileSync(tar, ["-xf", archive, "-C", work])
      const target = path.join(versions, version)
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(path.join(work, name), target)
      await link(layout, version)
      await prune(versions, [version, ...(previous ? [previous] : [])])
      log.info("download completed", { version })
    } finally {
      await fs.rm(work, { recursive: true, force: true })
    }
  }

  async function get(url: string, signal?: AbortSignal) {
    const res = await fetch(url, withTrustedTls({ signal }))
    if (!res.ok) throw new Error(I18n.t("cli.upgrade.downloadFailed", { url, status: res.status }))
    return res
  }

  async function sha256(file: string) {
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest("hex")
  }

  /** Points the command at `version`. Writes a temp file and renames it so the command is always usable. */
  async function link(layout: Layout, version: string) {
    await fs.mkdir(layout.bin, { recursive: true })
    for (const name of commands) {
      const file = command(layout, name)
      const temp = `${file}.${process.pid}.tmp`
      if (process.platform === "win32") {
        const target = path.join(layout.home, "versions", version, "bin", `${name}.cmd`)
        await fs.writeFile(temp, `@echo off\r\n"${target}" %*\r\n`)
      } else {
        await fs.rm(temp, { force: true })
        await fs.symlink(path.join(layout.home, "versions", version, "bin", name), temp)
      }
      await fs.rename(temp, file)
    }
  }

  async function prune(versions: string, keep: string[]) {
    for (const entry of await fs.readdir(versions)) {
      if (keep.includes(entry)) continue
      await fs.rm(path.join(versions, entry), { recursive: true, force: true }).catch((error: unknown) => {
        // On Windows an old version may still be running (files locked); it is removed on the next upgrade.
        log.warn("old version not removed", { version: entry, error })
      })
    }
  }
}
