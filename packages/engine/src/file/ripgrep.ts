// Ripgrep utility functions
import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"
import { NamedError } from "@merakcode/util/error"
import { lazy } from "../util/lazy"

import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js"
import { Log } from "@merakcode/log/logger"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Glob } from "@merakcode/util/glob"

export namespace Ripgrep {
  const log = Log.create({ service: "ripgrep" })
  const Stats = z.object({
    elapsed: z.object({
      secs: z.number(),
      nanos: z.number(),
      human: z.string(),
    }),
    searches: z.number(),
    searches_with_match: z.number(),
    bytes_searched: z.number(),
    bytes_printed: z.number(),
    matched_lines: z.number(),
    matches: z.number(),
  })

  const Begin = z.object({
    type: z.literal("begin"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
    }),
  })

  export const Match = z.object({
    type: z.literal("match"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      lines: z.object({
        text: z.string(),
      }),
      line_number: z.number(),
      absolute_offset: z.number(),
      submatches: z.array(
        z.object({
          match: z.object({
            text: z.string(),
          }),
          start: z.number(),
          end: z.number(),
        }),
      ),
    }),
  })

  const End = z.object({
    type: z.literal("end"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      binary_offset: z.number().nullable(),
      stats: Stats,
    }),
  })

  const Summary = z.object({
    type: z.literal("summary"),
    data: z.object({
      elapsed_total: z.object({
        human: z.string(),
        nanos: z.number(),
        secs: z.number(),
      }),
      stats: Stats,
    }),
  })

  const Result = z.union([Begin, Match, End, Summary])

  export type Result = z.infer<typeof Result>
  export type Match = z.infer<typeof Match>
  export type Begin = z.infer<typeof Begin>
  export type End = z.infer<typeof End>
  export type Summary = z.infer<typeof Summary>
  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": {
      platform: "aarch64-unknown-linux-gnu",
      extension: "tar.gz",
    },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  export const ExtractionFailedError = NamedError.create(
    "RipgrepExtractionFailedError",
    z.object({
      filepath: z.string(),
      stderr: z.string(),
    }),
  )

  export const UnsupportedPlatformError = NamedError.create(
    "RipgrepUnsupportedPlatformError",
    z.object({
      platform: z.string(),
    }),
  )

  export const DownloadFailedError = NamedError.create(
    "RipgrepDownloadFailedError",
    z.object({
      url: z.string(),
      status: z.number(),
    }),
  )

  /** Directory names the walk fallback skips when rg is missing, matching IGNORE_PATTERNS of the ls tool */
  const WALK_IGNORE_DIRS = new Set([
    "node_modules",
    "__pycache__",
    ".git",
    "dist",
    "build",
    "target",
    "vendor",
    "bin",
    "obj",
    ".idea",
    ".vscode",
    ".zig-cache",
    "zig-out",
    ".coverage",
    "coverage",
    "tmp",
    "temp",
    ".cache",
    "cache",
    "logs",
    ".venv",
    "venv",
    "env",
  ])

  type RipgrepState = { filepath: string | undefined }

  function parseWalkIgnores(globs?: string[]) {
    const ignores = new Set(WALK_IGNORE_DIRS)
    if (!globs) return ignores

    for (const glob of globs) {
      if (!glob.startsWith("!")) continue
      const pattern = glob.slice(1).replace(/\/\*$/, "").replace(/\/$/, "")
      const top = pattern.split("/")[0]
      if (top) ignores.add(top)
    }

    return ignores
  }

  /**
   * rg download timeout. fetch never times out by default: offline or on an intranet without GitHub access the request
   * hangs, and content search (grep), which waits for rg, hangs with it without any feedback. File listing does not wait:
   * it walks the folders until rg is there. The caller catches the timeout, so failing fast beats waiting forever.
   */
  const DOWNLOAD_TIMEOUT_MS = 15_000

  async function downloadRipgrep(filepath: string) {
    const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
    const config = PLATFORM[platformKey]
    if (!config) throw new UnsupportedPlatformError({ platform: platformKey })

    const version = "14.1.1"
    const filename = `ripgrep-${version}-${config.platform}.${config.extension}`
    // Intranet or offline setups cannot reach GitHub Releases, so MERAKCODE_RIPGREP_BASE_URL may point to a mirror.
    // Without rg, files() falls back to the walkFiles scan but search() and the grep tool are unavailable, so local and
    // CI environments need one of: rg on PATH, rg downloaded to Global.Path.bin, or this variable.
    const base = process.env.MERAKCODE_RIPGREP_BASE_URL ?? "https://github.com/BurntSushi/ripgrep/releases/download"
    const url = `${base}/${version}/${filename}`

    // A call that may hang needs a start record, otherwise production logs never show the download (host only, not
    // the full URL)
    const started = Date.now()
    log.debug("ripgrep download started", { version, host: new URL(url).host, timeout: DOWNLOAD_TIMEOUT_MS })
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch((error) => {
      log.warn("ripgrep download failed", {
        version,
        host: new URL(url).host,
        duration: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    if (!response.ok) throw new DownloadFailedError({ url, status: response.status })

    const buffer = await response.arrayBuffer()
    const archivePath = path.join(Global.Path.bin, filename)
    await Filesystem.write(archivePath, buffer)
    if (config.extension === "tar.gz") {
      const args = ["tar", "-xzf", archivePath, "--strip-components=1"]

      if (platformKey.endsWith("-darwin")) args.push("--include=*/rg")
      if (platformKey.endsWith("-linux")) args.push("--wildcards", "*/rg")

      const proc = Process.spawn(args, {
        cwd: Global.Path.bin,
        stderr: "pipe",
        stdout: "pipe",
      })
      await proc.exited
      if (proc.exitCode !== 0)
        throw new ExtractionFailedError({
          filepath,
          stderr: await new Response(proc.stderr).text(),
        })
    }
    if (config.extension === "zip") {
      const zipFileReader = new ZipReader(new BlobReader(new Blob([await Filesystem.readBytes(archivePath)])))
      const entries = await zipFileReader.getEntries()
      let rgEntry: any
      for (const entry of entries) {
        if (entry.filename.endsWith("rg.exe")) {
          rgEntry = entry
          break
        }
      }

      if (!rgEntry) {
        throw new ExtractionFailedError({
          filepath: archivePath,
          stderr: "rg.exe not found in zip archive",
        })
      }

      const rgBlob = await rgEntry.getData(new BlobWriter())
      if (!rgBlob) {
        throw new ExtractionFailedError({
          filepath: archivePath,
          stderr: "Failed to extract rg.exe from zip archive",
        })
      }
      await Filesystem.write(filepath, await rgBlob.arrayBuffer())
      await zipFileReader.close()
    }
    await fs.unlink(archivePath)
    if (!platformKey.endsWith("-win32")) await fs.chmod(filepath, 0o755)
  }

  async function* walkFiles(input: {
    cwd: string
    glob?: string[]
    hidden?: boolean
    maxDepth?: number
    signal?: AbortSignal
  }) {
    const positiveGlob = input.glob?.length === 1 && !input.glob[0].startsWith("!") ? input.glob[0] : undefined
    if (positiveGlob) {
      const glob = new Glob(positiveGlob)
      for await (const file of glob.scan({ cwd: input.cwd, onlyFiles: true, dot: input.hidden !== false })) {
        input.signal?.throwIfAborted()
        yield file
      }
      return
    }

    const hidden = input.hidden !== false
    const ignores = parseWalkIgnores(input.glob)
    const sep = path.sep

    async function* walk(dir: string, depth: number, prefix: string): AsyncGenerator<string> {
      input.signal?.throwIfAborted()
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (ignores.has(entry.name)) continue
        if (!hidden && entry.name.startsWith(".")) continue

        const rel = prefix ? `${prefix}${sep}${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (input.maxDepth !== undefined && depth >= input.maxDepth) continue
          yield* walk(path.join(dir, entry.name), depth + 1, rel)
          continue
        }

        if (entry.isFile()) yield rel
      }
    }

    yield* walk(input.cwd, 0, "")
  }

  const downloaded = () => path.join(Global.Path.bin, "rg" + (process.platform === "win32" ? ".exe" : ""))

  /** rg on PATH or downloaded before, found without touching the network */
  async function installed() {
    const system = Process.which("rg")
    if (system) {
      const stat = await fs.stat(system).catch(() => undefined)
      if (stat?.isFile()) return system
      log.warn("which returned invalid rg path", { filepath: system })
    }
    const filepath = downloaded()
    return (await Filesystem.isFile(filepath)) ? filepath : undefined
  }

  const state = lazy(async (): Promise<RipgrepState> => {
    const found = await installed()
    if (found) return { filepath: found }
    const filepath = downloaded()
    // Offline or CI setups can skip the download explicitly: treated as "no rg" without touching the network, the
    // same fallback as a failed download (file listing uses the walk scan, content search is unavailable)
    if (process.env["MERAKCODE_RIPGREP_DISABLE_DOWNLOAD"] === "1") {
      log.info("ripgrep download skipped (MERAKCODE_RIPGREP_DISABLE_DOWNLOAD=1), file listing falls back to walk scan")
      return { filepath: undefined }
    }
    try {
      await fs.mkdir(Global.Path.bin, { recursive: true })
      await downloadRipgrep(filepath)
    } catch (error) {
      log.warn("ripgrep unavailable: file listing falls back to walk scan, content search is disabled", {
        filepath,
        error,
      })
      return { filepath: undefined }
    }

    if (!(await Filesystem.isFile(filepath))) {
      log.warn(
        "ripgrep binary missing after install: file listing falls back to walk scan, content search is disabled",
        { filepath },
      )
      return { filepath: undefined }
    }

    return { filepath }
  })

  /** The remembered binary may have been deleted since (cleaned data folder, uninstall): then look it up again */
  export async function filepath() {
    const { filepath: rg } = await state()
    if (!rg || (await Filesystem.isFile(rg))) return rg
    log.warn("ripgrep binary disappeared, looking it up again", { filepath: rg })
    state.reset()
    return (await state()).filepath
  }

  export async function* files(input: {
    cwd: string
    glob?: string[]
    hidden?: boolean
    follow?: boolean
    maxDepth?: number
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()

    if (!(await fs.stat(input.cwd).catch(() => undefined))?.isDirectory()) {
      throw Object.assign(new Error(`No such file or directory: '${input.cwd}'`), {
        code: "ENOENT",
        errno: -2,
        path: input.cwd,
      })
    }

    // Listing files does not wait for a download, which can take until its timeout when GitHub is out of reach: it
    // walks the folders now and leaves rg downloading for content search and the listings after it
    const rg = await installed()
    if (!rg) {
      void filepath()
      yield* walkFiles(input)
      return
    }

    const args = [rg, "--files", "--glob=!.git/*"]
    if (input.follow) args.push("--follow")
    if (input.hidden !== false) args.push("--hidden")
    if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
    if (input.glob) {
      for (const g of input.glob) {
        args.push(`--glob=${g}`)
      }
    }

    const proc = Process.spawn(args, {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "ignore",
      signal: input.signal,
    })

    const reader = proc.stdout!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    // Output is capped at 20MB; rg is stopped beyond that
    const maxBuffer = 1024 * 1024 * 20
    let total = 0

    try {
      while (true) {
        input.signal?.throwIfAborted()

        const { done, value } = await reader.read()
        if (done) break

        total += value.byteLength
        if (total > maxBuffer) proc.kill()
        buffer += decoder.decode(value, { stream: true })
        // Handle both Unix (\n) and Windows (\r\n) line endings
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line) yield line
        }
      }

      if (buffer) yield buffer
    } finally {
      reader.releaseLock()
      await proc.exited
    }

    input.signal?.throwIfAborted()
  }

  export async function tree(input: { cwd: string; limit?: number; signal?: AbortSignal }) {
    log.info("tree", input)
    const files = await Array.fromAsync(Ripgrep.files({ cwd: input.cwd, signal: input.signal }))
    interface Node {
      name: string
      children: Map<string, Node>
    }

    function dir(node: Node, name: string) {
      const existing = node.children.get(name)
      if (existing) return existing
      const next = { name, children: new Map() }
      node.children.set(name, next)
      return next
    }

    const root: Node = { name: "", children: new Map() }
    for (const file of files) {
      if (file.includes(".merakcode")) continue
      const parts = file.split(path.sep)
      if (parts.length < 2) continue
      let node = root
      for (const part of parts.slice(0, -1)) {
        node = dir(node, part)
      }
    }

    function count(node: Node): number {
      let total = 0
      for (const child of node.children.values()) {
        total += 1 + count(child)
      }
      return total
    }

    const total = count(root)
    const limit = input.limit ?? total
    const lines: string[] = []
    const queue: { node: Node; path: string }[] = []
    for (const child of Array.from(root.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
      queue.push({ node: child, path: child.name })
    }

    let used = 0
    for (let i = 0; i < queue.length && used < limit; i++) {
      const { node, path } = queue[i]
      lines.push(path)
      used++
      for (const child of Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
        queue.push({ node: child, path: `${path}/${child.name}` })
      }
    }

    if (total > used) lines.push(`[${total - used} truncated]`)

    return lines.join("\n")
  }

  export async function search(input: {
    cwd: string
    pattern: string
    glob?: string[]
    limit?: number
    follow?: boolean
  }) {
    const rg = await filepath()
    if (!rg) {
      log.warn("ripgrep search skipped: binary unavailable", { cwd: input.cwd, pattern: input.pattern })
      return []
    }

    const args = [rg, "--json", "--hidden", "--glob=!.git/*"]
    if (input.follow) args.push("--follow")

    if (input.glob) {
      for (const g of input.glob) {
        args.push(`--glob=${g}`)
      }
    }

    if (input.limit) {
      args.push(`--max-count=${input.limit}`)
    }

    args.push("--")
    args.push(input.pattern)

    const result = await Process.run(args, { cwd: input.cwd, nothrow: true })
    if (result.exitCode !== 0) {
      return []
    }

    // Handle both Unix (\n) and Windows (\r\n) line endings
    const lines = result.text().trim().split(/\r?\n/).filter(Boolean)
    // Parse JSON lines from ripgrep output

    return lines
      .map((line) => JSON.parse(line))
      .map((parsed) => Result.parse(parsed))
      .filter((r) => r.type === "match")
      .map((r) => r.data)
  }
}
