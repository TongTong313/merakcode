import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm, truncate, writeFile, type FileHandle } from "node:fs/promises"
import { arch, homedir, release } from "node:os"
import { basename, join, posix, win32 } from "node:path"
import { randomUUID } from "node:crypto"
import { sanitize, type LogRecord } from "./record"
import type { Sink } from "./index"
import { nativeEvidence } from "./crash-evidence.cjs"
import { windowsEvents } from "./windows"
export { CrashEvidence } from "./crash-evidence.cjs"

export interface LogRootOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

/** logs/ under the MerakCode root (~/.merakcode, moved by MERAKCODE_HOME); MERAKCODE_LOG_ROOT puts logs anywhere */
export function resolveLogRoot(options: LogRootOptions = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  if (env.MERAKCODE_LOG_ROOT) return env.MERAKCODE_LOG_ROOT.replaceAll("\0", "")
  const paths = platform === "win32" ? win32 : posix
  return paths.join(env.MERAKCODE_HOME?.replaceAll("\0", "") || paths.join(home, ".merakcode"), "logs")
}

function safe(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "unknown"
}

function positive(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback
}

function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function files(dir: string) {
  try {
    return readdirSync(dir).flatMap((name) => {
      try {
        const file = join(dir, name)
        const stat = lstatSync(file)
        return stat.isFile() ? [{ file, name, time: stat.mtimeMs, size: stat.size }] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** Never recurse into user directories or follow symlinks. Active writers are protected. */
export function pruneLogs(
  dir: string,
  options: { days?: number; bytes?: number; count?: number; diagnostics?: boolean } = {},
) {
  const days = positive(options.days ?? process.env.MERAKCODE_LOG_RETENTION_DAYS, 7, 365)
  const limit = positive(options.bytes ?? process.env.MERAKCODE_LOG_TOTAL_BYTES, 200 * 1024 * 1024)
  const count = positive(options.count, 500)
  let bytes = 0
  let kept = 0
  files(dir)
    .filter((item) =>
      options.diagnostics ? item.name.endsWith(".json") : /--\d+--[a-f0-9-]+(?:\.\d+)?\.ndjson$/.test(item.name),
    )
    .sort((a, b) => b.time - a.time)
    .forEach((item) => {
      bytes += item.size
      kept++
      const pid = Number(item.name.match(/--(\d+)--/)?.[1])
      if (!options.diagnostics && alive(pid)) return
      if (kept <= count && bytes <= limit && item.time >= Date.now() - days * 86400000) return
      try {
        rmSync(item.file, { force: true })
      } catch {}
    })
}

export interface FileSinkOptions {
  root?: string
  component: string
  /** Optional safe subdirectory path, relative to the environment directory. */
  directory?: string[]
  name?: string
  dev?: boolean
  rotate?: { size: number; files: number }
  retention?: { days: number; bytes: number; count: number }
  /** Maximum bytes buffered, including the batch currently being written. */
  bufferSize?: number
  bufferRecords?: number
}

export class FileSink implements Sink {
  readonly file: string
  readonly dir: string
  private handle?: FileHandle
  private size = 0
  private readonly rotate
  private readonly timer
  private readonly root
  private readonly component
  private reported = false
  private readonly limit
  private readonly capacity
  private readonly retention
  private queue: Buffer[] = []
  private work = Promise.resolve()
  private draining = false
  private failed = false
  private closed = false
  private closing?: Promise<void>
  private accepted = 0
  private completed = 0
  private queuedBytes = 0

  constructor(options: FileSinkOptions) {
    this.root = options.root ?? resolveLogRoot()
    this.component = options.component
    this.dir = join(
      this.root,
      options.dev ? "development" : "production",
      ...(options.directory ?? [options.component]).map(safe),
    )
    // UTC creation time is Windows-safe; keep the PID/UUID suffix compatible with historical cleanup.
    const created = new Date().toISOString().replaceAll(/[:.]/g, "-")
    this.file = join(
      this.dir,
      `${safe(options.name ?? options.component)}--${created}--${process.pid}--${randomUUID()}.ndjson`,
    )
    this.rotate = {
      size: positive(options.rotate?.size ?? process.env.MERAKCODE_LOG_MAX_BYTES, 20 * 1024 * 1024),
      files: positive(options.rotate?.files ?? process.env.MERAKCODE_LOG_MAX_FILES, 5, 20),
    }
    this.limit = positive(options.bufferSize, 4 * 1024 * 1024)
    this.capacity = positive(options.bufferRecords, 8_192)
    this.retention = options.retention
    this.append(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      this.handle = await open(this.file, "ax", 0o600)
      await this.prune()
    })
    this.timer = setInterval(() => this.append(() => this.prune()), 30 * 60 * 1000)
    this.timer.unref()
  }

  get healthy() {
    return !this.failed
  }

  write(record: LogRecord | string) {
    if (this.closed || this.failed) return 0
    try {
      let line = typeof record === "string" ? record : JSON.stringify(record) + "\n"
      if (Buffer.byteLength(line) > this.rotate.size) {
        const compact =
          typeof record === "string"
            ? { message: "<oversized-record>" }
            : { ...record, attributes: { truncated: true }, message: "<oversized-record>" }
        line = JSON.stringify(compact) + "\n"
        if (Buffer.byteLength(line) > this.rotate.size) return 0
      }
      const bytes = Buffer.byteLength(line)
      if (!bytes || bytes > this.limit - this.queuedBytes || this.queue.length >= this.capacity) return 0
      this.queue.push(Buffer.from(line))
      this.queuedBytes += bytes
      this.accepted++
      this.schedule()
      return bytes
    } catch {
      return 0
    }
  }

  /** Wait for records already accepted at the time of this call. */
  async flush() {
    const target = this.accepted
    this.schedule()
    await this.work
    while (!this.failed && this.completed < target) {
      this.schedule()
      await this.work
    }
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    clearInterval(this.timer)
    this.closing = this.flush().then(() => this.append(() => this.finish()))
    return this.closing
  }

  private append(operation: () => Promise<void>) {
    this.work = this.work.then(operation).catch((error) => this.fail(error))
    return this.work
  }

  private schedule() {
    if (this.draining || this.failed || !this.queue.length) return
    this.draining = true
    this.append(async () => {
      await this.drain()
      this.draining = false
      if (this.queue.length) this.schedule()
    })
  }

  private async drain() {
    if (this.failed) return
    const target = this.accepted
    while (this.completed < target) {
      const first = this.queue[0]!
      if (this.size > 0 && this.size + first.length > this.rotate.size) await this.roll()
      let bytes = first.length
      let count = 1
      while (count < this.queue.length && count < target - this.completed) {
        const next = this.queue[count]!.length
        if (bytes + next > 64 * 1024 || this.size + bytes + next > this.rotate.size) break
        bytes += next
        count++
      }
      const buffer = count === 1 ? first : Buffer.concat(this.queue.slice(0, count), bytes)
      const start = this.size
      const write = async () => {
        let offset = 0
        while (offset < buffer.length) {
          const written = await this.handle!.write(buffer, offset, Math.min(64 * 1024, buffer.length - offset), null)
          if (!written.bytesWritten)
            throw Object.assign(new Error("Log write made no progress"), { code: "WRITE_ZERO" })
          offset += written.bytesWritten
          this.size += written.bytesWritten
        }
      }
      try {
        await write()
      } catch {
        // Reopen once and roll back an incomplete batch before replaying accepted records.
        await this.finish()
        await truncate(this.file, start)
        this.handle = await open(this.file, "a", 0o600)
        this.size = start
        await write()
      }
      this.queue.splice(0, count)
      this.queuedBytes -= bytes
      this.completed += count
    }
  }

  private async fail(error: unknown) {
    this.failed = true
    clearInterval(this.timer)
    this.queue = []
    this.queuedBytes = 0
    this.completed = this.accepted
    if (!this.reported) {
      this.reported = true
      const dir = join(this.root, "diagnostics")
      await mkdir(dir, { recursive: true, mode: 0o700 })
        .then(() =>
          writeFile(
            join(dir, `log-writer--${process.pid}--${randomUUID()}.json`),
            JSON.stringify({
              type: "log_writer_failure",
              component: this.component,
              pid: process.pid,
              timestamp: new Date().toISOString(),
              code: safe((error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"),
            }),
            { flag: "wx", mode: 0o600 },
          ),
        )
        .catch(() => {})
    }
    await this.finish()
  }

  private async finish() {
    const handle = this.handle
    this.handle = undefined
    await handle?.close().catch(() => {})
  }

  private async prune() {
    const options = this.retention
    const days = positive(options?.days ?? process.env.MERAKCODE_LOG_RETENTION_DAYS, 7, 365)
    const limit = positive(options?.bytes ?? process.env.MERAKCODE_LOG_TOTAL_BYTES, 200 * 1024 * 1024)
    const count = positive(options?.count, 500)
    const entries = await readdir(this.dir).catch(() => [])
    const items = []
    for (const name of entries) {
      if (!/--\d+--[a-f0-9-]+(?:\.\d+)?\.ndjson$/.test(name)) continue
      const file = join(this.dir, name)
      const stat = await lstat(file).catch(() => undefined)
      if (stat?.isFile()) items.push({ file, name, time: stat.mtimeMs, size: stat.size })
    }
    let bytes = 0
    let kept = 0
    for (const item of items.sort((a, b) => b.time - a.time)) {
      bytes += item.size
      kept++
      if (alive(Number(item.name.match(/--(\d+)--/)?.[1]))) continue
      if (kept <= count && bytes <= limit && item.time >= Date.now() - days * 86400000) continue
      await rm(item.file, { force: true }).catch(() => {})
    }
  }

  private rolled(index: number) {
    return this.file.replace(/\.ndjson$/, `.${index}.ndjson`)
  }

  private async roll() {
    await this.handle!.close()
    this.handle = undefined
    if (this.rotate.files === 1) await rm(this.file, { force: true })
    else {
      await rm(this.rolled(this.rotate.files - 1), { force: true })
      for (let index = this.rotate.files - 2; index >= 0; index--) {
        try {
          await rename(index === 0 ? this.file : this.rolled(index), this.rolled(index + 1))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
    }
    this.handle = await open(this.file, "a", 0o600)
    this.size = 0
  }
}

export interface RunTrackerOptions {
  root?: string
  component: string
  version?: string
  argv?: string[]
  runId?: string
}

/** Next-start diagnosis is silent. Abnormal exit is not synonymous with a crash. */
export class RunTracker {
  readonly runId: string
  readonly marker: string
  readonly diagnostics: string[] = []
  private readonly onExit = () => this.close()

  private constructor(options: RunTrackerOptions) {
    const root = options.root ?? resolveLogRoot()
    const component = safe(options.component)
    this.runId = safe(options.runId ?? randomUUID())
    const state = join(root, ".state", "runs")
    const output = join(root, "diagnostics")
    mkdirSync(state, { recursive: true, mode: 0o700 })
    mkdirSync(output, { recursive: true, mode: 0o700 })
    const recovered = new Set<string>()
    files(join(root, ".state", "crash-evidence")).forEach((item) => {
      if (!/\.(json|stderr\.log)$/.test(item.name)) return
      try {
        // Legacy raw evidence is not copied into the new diagnostics directory.
        if (item.size > 128 * 1024) return
        const content = readFileSync(item.file, "utf8")
        const meta = JSON.parse(item.name.endsWith(".stderr.log") ? content.split("\n")[0]! : content)
        if (alive(meta.owner_pid)) return
        const evidence = item.name.endsWith(".stderr.log") ? nativeEvidence(content) : meta.evidence
        const crash = evidence?.runtime_crash_signature || evidence?.native_fault_signature
        this.report(output, {
          type: crash ? "native_runtime_crash" : "abnormal_process_exit",
          component: meta.component,
          run_id: meta.run_id,
          evidence,
          exit_code: meta.exit_code,
          signal: meta.signal,
          note: "Module names are observations only; they do not prove injection or root cause. An abnormal exit may also be a forced termination or shutdown.",
        })
        recovered.add(`${meta.component}:${meta.run_id}`)
        rmSync(item.file, { force: true })
      } catch {
        /* Preserve evidence when recovery fails; retry next launch. */
      }
    })
    const markers = files(state)
    const abnormal: { pid: number; started_at?: string; run_id?: string }[] = []
    markers
      .filter((item) => item.name.endsWith(".json") && !item.name.endsWith(".expected.json"))
      .forEach((item) => {
        try {
          if (item.size > 16384) return
          const marker = JSON.parse(readFileSync(item.file, "utf8"))
          if (alive(marker.pid)) return
          const expected = item.file.replace(/\.json$/, ".expected.json")
          const intentional = markers.some((file) => file.file === expected)
          if (!intentional) abnormal.push({ pid: marker.pid, started_at: marker.started_at, run_id: marker.run_id })
          if (!intentional && !recovered.has(`${marker.component}:${marker.run_id}`)) {
            this.report(output, {
              type: "abnormal_exit",
              previous_run: marker,
              note: "No clean exit marker; cause is unknown (crash, forced termination or shutdown).",
            })
          }
          rmSync(item.file, { force: true })
          rmSync(expected, { force: true })
        } catch {}
      })
    pruneLogs(output, {
      diagnostics: true,
      days: positive(process.env.MERAKCODE_DIAGNOSTIC_RETENTION_DAYS, 30, 365),
      count: 50,
      bytes: 10 * 1024 * 1024,
    })
    files(state)
      .filter((item) => item.name.endsWith(".expected.json") && item.time < Date.now() - 30 * 86400000)
      .forEach((item) => {
        try {
          rmSync(item.file, { force: true })
        } catch {}
      })
    this.marker = join(state, `${component}-${this.runId}-${process.pid}.json`)
    writeFileSync(
      this.marker,
      JSON.stringify({
        schema: "merakcode.run.v1",
        run_id: this.runId,
        component,
        pid: process.pid,
        parent_pid: process.ppid,
        started_at: new Date().toISOString(),
        version: options.version,
        platform: process.platform,
        arch: arch(),
        os_release: release(),
        runtime: `${process.release.name} ${process.version}`,
        argv: (options.argv ?? process.argv.slice(1))
          .slice(0, 30)
          .map((value, index) =>
            index === 0 ? basename(value) : value.startsWith("--") ? value.split("=")[0]!.slice(0, 80) : "<value>",
          ),
      }),
      { mode: 0o600 },
    )
    process.once("exit", this.onExit)
    windowsEvents(abnormal, (data) => this.report(output, data))
  }

  static start(options: RunTrackerOptions) {
    return new RunTracker(options)
  }

  static expectExit(options: { root?: string; component: string; runId: string; pid: number }) {
    try {
      const dir = join(options.root ?? resolveLogRoot(), ".state", "runs")
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, `${safe(options.component)}-${safe(options.runId)}-${options.pid}.expected.json`), "{}", {
        mode: 0o600,
      })
    } catch {}
  }

  close() {
    process.off("exit", this.onExit)
    try {
      rmSync(this.marker, { force: true })
    } catch {}
  }

  private report(output: string, report: Record<string, unknown>) {
    const target = join(output, `${Date.now()}-${randomUUID()}-${safe(String(report.type))}.json`)
    writeFileSync(
      target,
      JSON.stringify({
        schema: "merakcode.diagnostic.v1",
        detected_at: new Date().toISOString(),
        ...(sanitize(report) as object),
      }),
      { mode: 0o600 },
    )
    this.diagnostics.push(target)
  }
}
