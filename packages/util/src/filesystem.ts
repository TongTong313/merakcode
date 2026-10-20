import { realpathSync } from "node:fs"
import fs from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import mime from "mime-types"
import { Glob } from "./glob"

export namespace Filesystem {
  /** Path argument of the read/write helpers: a string or a file: URL */
  export type Target = string | URL

  const local = (p: Target) => (typeof p === "string" ? p : fileURLToPath(p))

  export const exists = (p: Target) =>
    fs
      .stat(p)
      .then(() => true)
      .catch(() => false)

  export const isDir = (p: Target) =>
    fs
      .stat(p)
      .then((s) => s.isDirectory())
      .catch(() => false)

  /** True when the path exists and is a file (false for directories) */
  export const isFile = (p: Target) =>
    fs
      .stat(p)
      .then((s) => s.isFile())
      .catch(() => false)

  /** Reads the file as text, stripping a leading UTF-8 BOM */
  export const readText = async (p: Target) => {
    const text = await fs.readFile(p, "utf8")
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }

  export const readJson = async (p: Target): Promise<any> => JSON.parse(await readText(p))

  export const readBytes = async (p: Target) => new Uint8Array(await fs.readFile(p))

  /** File size in bytes; 0 when the file does not exist */
  export const size = (p: Target) =>
    fs
      .stat(p)
      .then((s) => s.size)
      .catch(() => 0)

  export type Data = string | ArrayBufferView | ArrayBuffer | Blob | Response

  /** Writes a file, creating missing parent directories */
  export async function write(p: Target, data: Data) {
    await fs.mkdir(dirname(local(p)), { recursive: true })
    if (typeof data === "string") return fs.writeFile(p, data)
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer())
    await fs.writeFile(p, bytes)
  }

  /** Reads the bytes in [start, end); anything past the end of the file is truncated */
  export async function readRange(p: Target, start: number, end: number) {
    const handle = await fs.open(p, "r")
    try {
      const buffer = new Uint8Array(Math.max(0, end - start))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  // mime-types maps .ts/.mts to MPEG transport stream (video/mp2t), so script extensions are handled separately
  const SCRIPT = /.(?:[cm]?[jt]s|[jt]sx)$/i

  /** Infers the MIME type from the extension; application/octet-stream when unknown */
  export function mimeType(p: string) {
    if (SCRIPT.test(p)) return "text/javascript;charset=utf-8"
    const type = mime.lookup(p)
    if (!type) return "application/octet-stream"
    return (mime.contentType(type) || type).replace("; charset=", ";charset=")
  }

  /** Copies a file, creating missing parent directories of the target */
  export async function copy(source: Target, target: Target) {
    await fs.mkdir(dirname(local(target)), { recursive: true })
    await fs.copyFile(source, target)
  }

  /**
   * On Windows, normalize a path to its canonical casing using the filesystem.
   * This is needed because Windows paths are case-insensitive but LSP servers
   * may return paths with different casing than what we send them.
   */
  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  export function overlaps(a: string, b: string) {
    const relA = relative(a, b)
    const relB = relative(b, a)
    return !relA || !relA.startsWith("..") || !relB || !relB.startsWith("..")
  }

  /**
   * Whether child is inside the parent directory tree. Both are resolved first so that mixing `/tmp` and `C:\\...`
   * on Windows does not give a wrong answer. Paths on different drives never contain each other.
   */
  export function contains(parent: string, child: string) {
    const a = resolve(parent)
    const b = resolve(child)
    if (process.platform === "win32") {
      const drive = (p: string) => {
        const m = /^([a-zA-Z]):/.exec(p)
        return m ? m[1].toLowerCase() : ""
      }
      const da = drive(a)
      const db = drive(b)
      if (da && db && da !== db) return false
    }
    const rel = relative(a, b)
    return !rel.startsWith("..") && rel !== ".."
  }

  /** Stops once current and stop are the same directory; slash or drive-letter case differences do not count */
  function atStop(current: string, stop?: string) {
    return stop !== undefined && Filesystem.sameDirectory(current, stop)
  }

  export async function findUp(target: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      const search = join(current, target)
      if (await exists(search)) result.push(search)
      if (atStop(current, stop)) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  export async function* up(options: { targets: string[]; start: string; stop?: string }) {
    const { targets, start, stop } = options
    let current = start
    while (true) {
      for (const target of targets) {
        const search = join(current, target)
        if (await exists(search)) yield search
      }
      if (atStop(current, stop)) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  export async function globUp(pattern: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      try {
        const glob = new Glob(pattern)
        for await (const match of glob.scan({
          cwd: current,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        })) {
          result.push(match)
        }
      } catch {
        // Skip invalid glob patterns
      }
      if (atStop(current, stop)) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  /**
   * Normalizes a directory path so trailing slashes and separators do not make equal paths compare unequal.
   * Must match workspaceKey in apps/desktop/renderer/src/pages/layout/helpers.ts exactly, otherwise the server and
   * the desktop UI filter sessions differently.
   *
   * Rules:
   * - strip trailing "/" or "\"
   * - keep drive roots such as "C:/" and "C:\"
   * - keep a bare root slash ("/" or "\")
   */
  export function normalize(directory: string): string {
    if (!directory) return directory
    const drive = directory.match(/^([A-Za-z]:)[\\/]+$/)
    if (drive) return `${drive[1]}${directory.includes("\\") ? "\\" : "/"}`
    if (/^[\\/]+$/.test(directory)) return directory.includes("\\") ? "\\" : "/"
    return directory.replace(/[\\/]+$/, "")
  }

  /**
   * Canonical key of a workspace directory, for per-directory caches such as Instance.
   * On top of normalize, converts to forward slashes and lowercases the Windows drive letter, so D:\ and d:\ (from
   * different sources) do not become two instances. Server-side session filtering reuses this via sameDirectory.
   */
  export function canonicalDirectory(directory: string): string {
    const normalized = normalize(directory).replace(/\\/g, "/")
    return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
  }

  /**
   * Whether two directory strings point to the same directory, ignoring drive-letter case (D:\ vs d:\), slash
   * direction and trailing slashes (same rules as canonicalDirectory). Used for filtering by directory, such as the
   * session list, so clients that spell the same directory differently still match.
   * Case outside the drive letter is not folded, and a subdirectory is not the same as its parent.
   */
  export function sameDirectory(a: string, b: string): boolean {
    // Old sessions may lack the directory field (Storage.read does not validate), so either side can be
    // undefined/null at runtime. Fall back to strict equality so canonicalDirectory never calls .replace on it.
    if (!a || !b) return a === b
    return canonicalDirectory(a) === canonicalDirectory(b)
  }

  /**
   * Whether two file paths point to the same file. Resolves first, then compares with canonicalDirectory: a `c:\...`
   * path from a client @ mention and a `C:\...` path found by Glob must match, otherwise the rule lookup fails and a
   * `.mdc` file is treated as a plain file, dumping its YAML into the user message.
   */
  export function sameFilepath(a: string, b: string): boolean {
    if (!a || !b) return a === b
    return canonicalDirectory(resolve(a)) === canonicalDirectory(resolve(b))
  }
}
