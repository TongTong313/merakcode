/**
 * Reads the log directory for `merak logs` and bug reports. Layout:
 * <root>/<production|development>/<component>/<name>--<created>--<pid>--<uuid>[.<n>].ndjson
 * One process writes one file (plus rotated .1, .2 … copies, higher is older); every line is a LogRecord.
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { LogRecord } from "./record"

export type Run = {
  id: string
  /** Directory under the mode: cli, server or desktop */
  component: string
  /** Process within the component: main, worker, backend … */
  name: string
  mode: "production" | "development"
  pid: number
  started: string
  modified: number
  size: number
  /** Oldest first */
  files: string[]
}

const FILE = /^(.+?)--(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)--(\d+)--([a-zA-Z0-9-]+?)(?:\.(\d+))?\.ndjson$/

const list = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function firstLine(file: string) {
  const buffer = Buffer.alloc(64 * 1024)
  const handle = openSync(file, "r")
  try {
    const bytes = readSync(handle, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytes).toString("utf8").split("\n")[0] ?? ""
  } finally {
    closeSync(handle)
  }
}

function runID(file: string) {
  try {
    const record = JSON.parse(firstLine(file)) as { run_id?: unknown }
    return typeof record.run_id === "string" ? record.run_id : ""
  } catch {
    return ""
  }
}

/** Every run under the log root, most recently written first */
export function listRuns(root: string): Run[] {
  const runs = (["production", "development"] as const).flatMap((mode) =>
    list(join(root, mode)).flatMap((component) => {
      const dir = join(root, mode, component)
      const groups = new Map<
        string,
        {
          name: string
          created: string
          pid: number
          parts: { file: string; index: number; time: number; size: number }[]
        }
      >()
      for (const entry of list(dir)) {
        const match = FILE.exec(entry)
        if (!match) continue
        const file = join(dir, entry)
        const stat = (() => {
          try {
            return lstatSync(file)
          } catch {
            return undefined
          }
        })()
        if (!stat?.isFile()) continue
        const key = `${match[1]}--${match[2]}--${match[3]}--${match[4]}`
        const group = groups.get(key) ?? { name: match[1]!, created: match[2]!, pid: Number(match[3]), parts: [] }
        group.parts.push({ file, index: Number(match[5] ?? 0), time: stat.mtimeMs, size: stat.size })
        groups.set(key, group)
      }
      return [...groups.values()].map((group) => {
        const files = group.parts.sort((a, b) => b.index - a.index).map((part) => part.file)
        const [date, time] = group.created.split("T") as [string, string]
        const [h, m, s, ms] = time.replace("Z", "").split("-")
        return {
          id: runID(files[0]!),
          component,
          name: group.name,
          mode,
          pid: group.pid,
          started: `${date}T${h}:${m}:${s}.${ms}Z`,
          modified: Math.max(...group.parts.map((part) => part.time)),
          size: group.parts.reduce((sum, part) => sum + part.size, 0),
          files,
        }
      })
    }),
  )
  return runs.sort((a, b) => b.modified - a.modified)
}

/** Records of one log file; lines that are not valid records are skipped */
export function readRecords(file: string): LogRecord[] {
  const text = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return ""
    }
  })()
  return parseRecords(text)
}

/** Records in NDJSON text; lines that are not records are skipped */
export function parseRecords(text: string): LogRecord[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      const record = JSON.parse(line) as LogRecord
      return typeof record === "object" && record !== null && typeof record.message === "string" ? [record] : []
    } catch {
      return []
    }
  })
}

/** Runs whose id starts with `id`; processes started for one run (MERAKCODE_RUN_ID) share its id */
export function filterRun(runs: Run[], id: string): Run[] {
  if (!id) return []
  return runs.filter((run) => run.id.startsWith(id))
}
