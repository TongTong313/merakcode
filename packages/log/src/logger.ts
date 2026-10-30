import { randomUUID } from "node:crypto"
import { buildRecord, formatText, type LogRecord } from "./index"
import { FileSink, RunTracker, resolveLogRoot } from "./node"
import z from "zod"
import { release } from "node:os"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>
  export const ConfigLevel = Level.optional().describe("Log level")

  const priorities: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"
  let component = "cli"
  let processRole = "main"
  let runId: string = randomUUID()
  let sequence = 0
  let sink: FileSink | undefined
  let sdkSink: FileSink | undefined
  let auditSink: FileSink | undefined
  let auditRejected = false
  const sinks = new Map<string, FileSink>()
  const channels = new Map<string, FileSink>()
  let tracker: RunTracker | undefined
  let print = true
  let logpath = ""
  let dev = false
  let active = false
  let generation = 0
  let closing = Promise.resolve()

  function shouldLog(input: Level) {
    return priorities[input] >= priorities[level]
  }

  export type Logger = {
    debug(message?: unknown, extra?: Record<string, unknown>): void
    info(message?: unknown, extra?: Record<string, unknown>): void
    error(message?: unknown, extra?: Record<string, unknown>): void
    warn(message?: unknown, extra?: Record<string, unknown>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, unknown>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()
  export const Default = create({ service: "default" })
  /** Host-owned events use the product writer; engine events use the SDK writer. */
  export const Product = create({ service: "default", source: "product" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
    /** Runtime component. Known components are grouped into user-facing product directories. */
    component?: string
    version?: string
    trackRun?: boolean
    /** Size-based rotation. The file count includes the active file. */
    rotate?: {
      size: number
      files: number
    }
  }

  export function file() {
    return logpath
  }

  export function sdkFile() {
    return sdkWriter()?.file ?? ""
  }

  export function id() {
    return runId
  }

  function role(options: Options) {
    if (options.component) return options.component
    if (process.env.MERAKCODE_LOG_COMPONENT) return process.env.MERAKCODE_LOG_COMPONENT
    if (process.env.MERAKCODE_CLIENT === "desktop") return "backend"
    return "cli"
  }

  function placement(value: string) {
    if (value === "cli") return { directory: ["cli"], name: "main", role: "main" }
    if (value === "desktop") return { directory: ["desktop"], name: "main", role: "main" }
    if (value === "backend") {
      return process.env.MERAKCODE_CLIENT === "desktop"
        ? { directory: ["desktop"], name: "backend", role: "backend" }
        : { directory: ["server"], name: "backend", role: "backend" }
    }
    if (value === "web") return { directory: ["server"], name: "browser", role: "browser" }
    return { directory: [value], name: value, role: value }
  }

  export async function init(options: Options) {
    const current = ++generation
    await close()
    if (current !== generation) return
    level =
      process.env.MERAKCODE_DIAGNOSTIC_LOGS === "1"
        ? "DEBUG"
        : !options.dev && options.level === "DEBUG"
          ? "INFO"
          : (options.level ?? "INFO")
    component = role(options)
    const place = placement(component)
    processRole = place.role
    dev = options.dev ?? false
    runId = process.env.MERAKCODE_RUN_ID || randomUUID()
    sequence = 0
    auditRejected = false
    print = options.print
    try {
      tracker =
        options.trackRun === false
          ? undefined
          : RunTracker.start({
              root: resolveLogRoot(),
              component,
              version: options.version,
              argv: process.argv.slice(1),
              runId,
            })
    } catch {
      tracker = undefined
    }
    try {
      sink = new FileSink({
        root: resolveLogRoot(),
        component,
        dev,
        directory: place.directory,
        name: place.name,
        rotate: options.rotate,
      })
    } catch {
      sink = undefined
    }
    logpath = sink?.file ?? ""
    active = true
    if (options.trackRun !== false)
      emit("INFO", "lifecycle", "logging initialized", {
        version: options.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        runtime: `${process.release.name} ${process.version}`,
        mode: dev ? "development" : "production",
        process_role: processRole,
      })
    // Reports are recorded on disk only, never surfaced in the terminal on next launch.
  }

  function outputs() {
    return [
      ...(sink ? [sink] : []),
      ...(sdkSink ? [sdkSink] : []),
      ...(auditSink ? [auditSink] : []),
      ...sinks.values(),
      ...channels.values(),
    ]
  }

  /** Business audit snapshots share the log root, but bypass diagnostic filtering and stderr. */
  export function writeAudit(line: string) {
    if (!active) return false
    try {
      auditSink ??= new FileSink({
        root: resolveLogRoot(),
        component,
        dev,
        directory: [...placement(component).directory, "sdk", "audit"],
        name: "records",
        retention: { days: 30, bytes: 50 * 1024 * 1024, count: 100 },
      })
      const accepted = auditSink.write(line) > 0
      if (!accepted) auditRejected = true
      return accepted
    } catch {
      auditRejected = true
      return false
    }
  }

  export function auditRoot() {
    return { root: resolveLogRoot(), environment: dev ? "development" : "production" }
  }

  export function auditIncomplete() {
    return auditRejected || auditSink?.healthy === false
  }

  /** Wait for records already accepted by every writer; later logging may continue. */
  export async function flush() {
    await Promise.allSettled([closing, ...outputs().map((item) => item.flush())])
  }

  /** Stop accepting records immediately, then drain and close all writers. */
  export function shutdown(): Promise<void> {
    generation++
    return close()
  }

  function close(): Promise<void> {
    active = false
    const writers = outputs()
    const previous = tracker
    sink = undefined
    sdkSink = undefined
    auditSink = undefined
    sinks.clear()
    channels.clear()
    tracker = undefined
    if (!writers.length && !previous) return closing
    closing = Promise.allSettled([closing, ...writers.map((item) => item.close())]).then(() => {
      try {
        previous?.close()
      } catch {}
    })
    return closing
  }

  type Channel = "update" | "approval" | "audit"

  const auditKeys = new Set([
    "kind",
    "actor",
    "choice",
    "outcome",
    "operation",
    "processId",
    "approvalId",
    "taskId",
    "instanceId",
    "sessionID",
    "interceptedAt",
    "result",
    "cause",
    "decision",
    "seconds",
    "controlMode",
    "timestamp",
  ])
  const auditText = /^[A-Za-z0-9_-]{1,128}$/

  function channelPlacement(channel: Channel) {
    if (channel === "update") {
      return {
        directory: ["cli", "update"],
        name: "update",
        retention: { days: 30, bytes: 50 * 1024 * 1024, count: 100 },
        silent: false,
      }
    }
    return {
      directory: [...placement(component).directory, "sdk", "audit"],
      name: channel,
      retention: { days: 30, bytes: 50 * 1024 * 1024, count: 100 },
      silent: true,
    }
  }

  function channelSink(channel: Channel) {
    const cached = channels.get(channel)
    if (cached) return cached
    if (!active) return
    try {
      const place = channelPlacement(channel)
      const target = new FileSink({
        root: resolveLogRoot(),
        component,
        dev,
        directory: place.directory,
        name: place.name,
        retention: place.retention,
      })
      channels.set(channel, target)
      return target
    } catch {
      return
    }
  }

  function sdkWriter() {
    if (sdkSink) return sdkSink
    if (!active) return
    try {
      const place = placement(component)
      sdkSink = new FileSink({
        root: resolveLogRoot(),
        component,
        dev,
        directory: [...place.directory, "sdk"],
        name: place.name,
      })
      return sdkSink
    } catch {
      return
    }
  }

  function emit(
    level: Level,
    service: string,
    message?: unknown,
    attributes?: Record<string, unknown>,
    channel?: Channel,
    source: "sdk" | "product" = "sdk",
  ) {
    if (!active || !shouldLog(level)) return
    try {
      const record = buildRecord({
        level,
        component,
        service,
        message,
        attributes: {
          ...(channel === "approval" || channel === "audit"
            ? Object.fromEntries(
                Object.entries(attributes ?? {}).filter(
                  ([key, value]) =>
                    auditKeys.has(key) &&
                    (typeof value === "number"
                      ? Number.isFinite(value)
                      : typeof value === "string" && auditText.test(value)),
                ),
              )
            : attributes),
          process_role: processRole,
        },
        runId,
        sequence: ++sequence,
      })
      if (print && !(channel && channelPlacement(channel).silent)) process.stderr.write(formatText(record))
      const output = channel ? channelSink(channel) : source === "sdk" ? sdkWriter() : sink
      output?.write(record)
    } catch {}
  }

  export function record(input: LogRecord) {
    if (!active || !shouldLog(input.level)) return
    try {
      if (print) process.stderr.write(formatText(input))
      if (input.component === component) {
        sink?.write(input)
        return
      }
      let target = sinks.get(input.component)
      if (!target) {
        if (sinks.size >= 8) return
        const place = placement(input.component)
        target = new FileSink({
          root: resolveLogRoot(),
          component: input.component,
          dev,
          directory: place.directory,
          name: place.name,
        })
        sinks.set(input.component, target)
      }
      target.write(input)
    } catch {}
  }

  export function ingest(input: {
    component: string
    service: string
    level: Level
    message: string
    runId?: string
    sequence?: number
    extra?: Record<string, unknown>
  }) {
    try {
      record(
        buildRecord({
          level: input.level,
          component: input.component,
          service: input.service,
          message: input.message,
          attributes: {
            ...input.extra,
            process_role: placement(input.component).role,
            receiver_run_id: runId,
          },
          pid: 0,
          runId: input.runId || runId,
          sequence: input.sequence ?? 0,
        }),
      )
    } catch {}
  }

  export function create(input: Record<string, unknown> = {}, fresh = false) {
    const tags = { ...input }
    const name = typeof tags.service === "string" ? tags.service : "default"
    const channel =
      tags.channel === "update" || tags.channel === "approval" || tags.channel === "audit" ? tags.channel : undefined
    const source = tags.source === "product" ? "product" : "sdk"
    delete tags.service
    delete tags.channel
    delete tags.source
    const key = `${channel ?? source}:${name}`
    const cached = loggers.get(key)
    if (cached && !fresh) return cached

    const result: Logger = {
      debug(message, extra) {
        emit("DEBUG", name, message, { ...tags, ...extra }, channel, source)
      },
      info(message, extra) {
        emit("INFO", name, message, { ...tags, ...extra }, channel, source)
      },
      error(message, extra) {
        emit("ERROR", name, message, { ...tags, ...extra }, channel, source)
      },
      warn(message, extra) {
        emit("WARN", name, message, { ...tags, ...extra }, channel, source)
      },
      tag(key, value) {
        tags[key] = value
        return result
      },
      clone() {
        return create({ service: name, channel, source, ...tags }, true)
      },
      time(message, extra) {
        const started = Date.now()
        result.info(message, { status: "started", ...extra })
        let stopped = false
        const stop = () => {
          if (stopped) return
          stopped = true
          result.info(message, { status: "completed", duration: Date.now() - started, ...extra })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }
    if (!fresh) loggers.set(key, result)
    return result
  }
}
