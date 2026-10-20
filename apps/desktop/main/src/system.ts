import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Small OS helpers: opening a project in a given editor or terminal, file paths on the clipboard, reading and writing
 * local files.
 */
export namespace System {
  /**
   * The `app` values in the renderer's editor list are application names on macOS (`open -a`) and commands on PATH
   * on Windows and Linux. A few applications have a command that differs from their display name.
   */
  const COMMANDS: Record<string, string> = { "Sublime Text": "subl" }

  /** Finds a command on PATH (on Windows, tries the PATHEXT extensions) */
  export function which(name: string, env = process.env, platform = process.platform) {
    const command = COMMANDS[name] ?? name
    if (path.isAbsolute(command)) return existsSync(command) ? command : undefined
    const separator = platform === "win32" ? ";" : ":"
    const dirs = (env.PATH ?? env.Path ?? "").split(separator).filter(Boolean)
    const extensions =
      platform === "win32"
        ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())]
        : [""]
    for (const dir of dirs)
      for (const ext of extensions) {
        const file = path.join(dir, command + ext)
        if (existsSync(file) && (platform !== "win32" || ext)) return file
      }
  }

  export async function exists(app: string, platform = process.platform) {
    if (platform === "darwin")
      return new Promise<boolean>((resolve) =>
        execFile("open", ["-Ra", app], { timeout: 5_000 }, (error) => resolve(!error)),
      )
    return Boolean(which(app))
  }

  /** Opens a file or directory with the given application */
  export async function open(target: string, app: string, platform = process.platform) {
    if (!existsSync(target)) throw new Error(`not found: ${target}`)
    if (platform === "darwin")
      return new Promise<void>((resolve, reject) =>
        execFile("open", ["-a", app, target], { timeout: 15_000 }, (error) => (error ? reject(error) : resolve())),
      )
    const command = which(app)
    if (!command) throw new Error(`not installed: ${app}`)
    const detached = { detached: true, stdio: "ignore" as const }
    const child = (() => {
      // Terminals open a new window in the project directory
      if (/^(powershell|pwsh)(\.exe)?$/i.test(path.basename(command)))
        return spawn(command, ["-NoExit"], { ...detached, cwd: target })
      if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
        // .cmd files only run through cmd.exe, which expands % and " even inside quotes, so reject them
        if (/[%"]/.test(target)) throw new Error(`unsupported path: ${target}`)
        return spawn("cmd.exe", ["/d", "/s", "/c", `""${command}" "${target}""`], {
          ...detached,
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      }
      return spawn(command, [target], detached)
    })()
    child.on("error", () => {})
    child.unref()
  }

  /** Whether the text looks like an absolute path (a path copied as plain text) */
  export function looksLikePath(text: string) {
    if (!text || /\s/.test(text)) return false
    return text.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/")
  }

  /**
   * Files on the clipboard: files copied in the system file manager are in text/uri-list (one file:// URL per line),
   * followed by absolute paths in the plain text
   */
  export function clipboardFiles(uris: string, text: string) {
    const fromUris = uris
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("file://"))
      .flatMap((line) => {
        try {
          return [fileURLToPath(line)]
        } catch {
          return []
        }
      })
    const fromText = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(looksLikePath)
    return [...new Set([...fromUris, ...fromText].map((item) => item.normalize("NFC")))]
  }

  const MAX_TEXT = 5 * 1024 * 1024
  export async function readText(file: string) {
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_TEXT) return null
    return readFile(file, "utf8").catch(() => null)
  }

  export async function writeText(file: string, content: string) {
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT) return false
    return mkdir(path.dirname(file), { recursive: true })
      .then(() => writeFile(file, content, "utf8"))
      .then(() => true)
      .catch(() => false)
  }
}
