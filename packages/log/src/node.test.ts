import { afterEach, expect, test, vi } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
  utimesSync,
  existsSync,
} from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { text } from "node:stream/consumers"
import { pathToFileURL } from "node:url"
import { CrashEvidence, FileSink, RunTracker, resolveLogRoot, pruneLogs } from "./node"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root() {
  const value = mkdtempSync(join(tmpdir(), "merakcode-telemetry-"))
  roots.push(value)
  return value
}

// Scripts import this package's .ts sources, so they need the source loader; on Windows --import only accepts
// file:// URLs
const register = new URL("../../../script/node/register.mjs", import.meta.url).href

/**
 * Runs an -e script with the current runtime and collects the exit code and output. Uses node:child_process
 * directly because this package does not depend on @merakcode/util.
 */
async function evaluate(source: string, env?: NodeJS.ProcessEnv) {
  const args = ["--import", register, "--disable-warning=ExperimentalWarning", "-e", source]
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  const [[code], stdout, stderr] = await Promise.all([once(child, "close"), text(child.stdout), text(child.stderr)])
  return { code: code as number | null, stdout, stderr }
}

test("logs live under the MerakCode root on every platform; MERAKCODE_HOME moves it, MERAKCODE_LOG_ROOT wins", () => {
  const cases = [
    {
      platform: "win32",
      home: "C:\\Users\\me",
      root: "D:\\merak",
      expected: "C:\\Users\\me\\.merakcode\\logs",
      custom: "D:\\merak\\logs",
    },
    {
      platform: "darwin",
      home: "/Users/me",
      root: "/data/merak",
      expected: "/Users/me/.merakcode/logs",
      custom: "/data/merak/logs",
    },
    {
      platform: "linux",
      home: "/home/me",
      root: "/data/merak",
      expected: "/home/me/.merakcode/logs",
      custom: "/data/merak/logs",
    },
  ] as const
  for (const item of cases) {
    expect(resolveLogRoot({ ...item, env: {} })).toBe(item.expected)
    expect(resolveLogRoot({ ...item, env: { MERAKCODE_HOME: "" } })).toBe(item.expected)
    expect(resolveLogRoot({ ...item, env: { MERAKCODE_HOME: item.root } })).toBe(item.custom)
    expect(resolveLogRoot({ ...item, env: { MERAKCODE_HOME: item.root, MERAKCODE_LOG_ROOT: "explicit-root" } })).toBe(
      "explicit-root",
    )
  }
})

test("standalone crash helper and runtime share the MerakCode root and explicit override", async () => {
  const dir = root()
  for (const override of ["", join(dir, "override")]) {
    const env = { ...process.env, MERAKCODE_HOME: dir, MERAKCODE_LOG_ROOT: override }
    const {
      code,
      stdout: output,
      stderr: error,
    } = await evaluate(
      `const { CrashEvidence } = require(${JSON.stringify(join(import.meta.dirname, "crash-evidence.cjs"))}); const evidence = new CrashEvidence({ component: "cli", runId: "paths" }); process.stdout.write(evidence.file);`,
      env,
    )
    expect(code, error).toBe(0)
    expect(output).toBe(join(resolveLogRoot({ env }), ".state", "crash-evidence", "cli-paths.json"))
    expect(existsSync(output)).toBe(true)
  }
})

test("log filenames include UTC creation time and preserve their identity across rotation", async () => {
  const before = Date.now()
  const sink = new FileSink({ root: root(), component: "cli", rotate: { size: 80, files: 3 } })
  const after = Date.now()
  const name = basename(sink.file)
  const match = name.match(/^cli--(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)--(\d+)--([a-f0-9-]+)\.ndjson$/)
  expect(match).not.toBeNull()
  const created = Date.parse(match![1]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z"))
  expect(created).toBeGreaterThanOrEqual(before)
  expect(created).toBeLessThanOrEqual(after)
  expect(Number(match![2])).toBe(process.pid)
  for (let index = 0; index < 10; index++) sink.write(JSON.stringify({ index, value: "x".repeat(30) }) + "\n")
  await sink.close()
  expect(readdirSync(sink.dir).sort()).toEqual(
    [name, name.replace(/\.ndjson$/, ".1.ndjson"), name.replace(/\.ndjson$/, ".2.ndjson")].sort(),
  )
})

test("separates component files and rotates them", async () => {
  const dir = root()
  const sink = new FileSink({ root: dir, component: "cli", rotate: { size: 80, files: 3 } })
  for (let index = 0; index < 10; index++) sink.write(JSON.stringify({ index, value: "x".repeat(30) }) + "\n")
  await sink.close()
  expect(readdirSync(sink.dir)).toHaveLength(3)
  expect(readdirSync(sink.dir).every((file) => statSync(join(sink.dir, file)).size <= 80)).toBe(true)
})

test("recovers a stale log handle and records an unrecoverable writer failure", async () => {
  const dir = root()
  const sink = new FileSink({ root: dir, component: "cli" })
  sink.write("before\n")
  await sink.flush()
  await (sink as unknown as { handle: FileHandle }).handle.close()
  expect(sink.write("recovered\n")).toBe(Buffer.byteLength("recovered\n"))
  await sink.flush()
  expect(readFileSync(sink.file, "utf8")).toBe("before\nrecovered\n")
  await (sink as unknown as { handle: FileHandle }).handle.close()
  rmSync(sink.file)
  mkdirSync(sink.file)
  expect(sink.write("unavailable\n")).toBe(Buffer.byteLength("unavailable\n"))
  await sink.flush()
  const reports = readdirSync(join(dir, "diagnostics"))
  expect(reports).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(dir, "diagnostics", reports[0]!), "utf8"))).toMatchObject({
    type: "log_writer_failure",
    component: "cli",
  })
  await sink.close()
})

test("silently converts a stale run marker into an abnormal-exit diagnostic", () => {
  const dir = root()
  const state = join(dir, ".state", "runs")
  const first = RunTracker.start({ root: dir, component: "cli", runId: "current" })
  first.close()
  writeFileSync(
    join(state, "cli-stale.json"),
    JSON.stringify({ schema: "merakcode.run.v1", run_id: "stale", component: "cli", pid: 2147483647 }),
  )
  const next = RunTracker.start({ root: dir, component: "cli", runId: "next" })
  expect(next.diagnostics).toHaveLength(1)
  expect(JSON.parse(readFileSync(next.diagnostics[0]!, "utf8")).type).toBe("abnormal_exit")
  next.close()
})

test("classifies Node runtime crash evidence without treating third-party modules as proof", () => {
  const dir = root()
  const evidence = join(dir, ".state", "crash-evidence")
  mkdirSync(evidence, { recursive: true })
  writeFileSync(
    join(evidence, "cli-old.stderr.log"),
    JSON.stringify({ owner_pid: 2147483647, component: "cli", run_id: "old" }) +
      "\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n" +
      "----- Native stack trace -----\naccess violation at 0x1234\nSecurityOverlay.dll\n",
  )
  const next = RunTracker.start({ root: dir, component: "cli", runId: "next" })
  const file = next.diagnostics.find((item) => item.includes("native_runtime_crash"))
  expect(file).toBeDefined()
  const report = JSON.parse(readFileSync(file!, "utf8"))
  expect(report.evidence).toMatchObject({
    runtime_crash_signature: true,
    native_fault_signature: true,
    modules_observed: ["SecurityOverlay.dll"],
  })
  expect(report.note).toContain("do not prove")
  next.close()
})

test("concurrent writers never share rotation files; oversized records remain bounded", async () => {
  const dir = root()
  const a = new FileSink({ root: dir, component: "cli", rotate: { size: 100, files: 1 } })
  const b = new FileSink({ root: dir, component: "cli", rotate: { size: 100, files: 1 } })
  expect(a.file).not.toBe(b.file)
  for (let i = 0; i < 20; i++) {
    a.write('{"writer":"a"}\n')
    b.write('{"writer":"b"}\n')
  }
  a.write("x".repeat(10000))
  await Promise.all([a.close(), b.close()])
  expect(statSync(a.file).size).toBeLessThanOrEqual(100)
  expect(readFileSync(b.file, "utf8")).not.toContain('"a"')
  expect(() =>
    readFileSync(a.file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).not.toThrow()
})

test("crash evidence keeps split native signatures but never raw stderr or credentials", () => {
  const dir = root()
  const evidence = new CrashEvidence({ root: dir, component: "cli", runId: "old" })
  evidence.write("private prompt Bearer topsecret --token hidden " + "x".repeat(1024 * 1024))
  evidence.write("\nNode.js v26.12.0\nFATAL ERR")
  evidence.write("OR: Reached heap limit\nSegmentation fault at address 0x1234\nSecurityOverlay.dll\n")
  evidence.close({ keep: true, code: 1 })
  const raw = readFileSync(evidence.file, "utf8")
  expect(raw).not.toContain("topsecret")
  expect(raw).not.toContain("hidden")
  expect(raw).not.toContain("private prompt")
  expect(statSync(evidence.file).size).toBeLessThan(8192)
  const next = RunTracker.start({ root: dir, component: "cli" })
  const report = JSON.parse(readFileSync(next.diagnostics[0]!, "utf8"))
  expect(report.evidence).toMatchObject({
    runtime_crash_signature: true,
    runtime_version: "26.12.0",
    fault_address: "0x1234",
    modules_observed: ["SecurityOverlay.dll"],
  })
  expect(existsSync(evidence.file)).toBe(false)
  next.close()
})

test("expected stops are not diagnosed as crashes and recovery is idempotent", () => {
  const dir = root()
  const tracker = RunTracker.start({ root: dir, component: "backend", runId: "live" })
  const state = join(dir, ".state", "runs")
  const name = "backend-old-2147483647.json"
  writeFileSync(join(state, name), JSON.stringify({ component: "backend", run_id: "old", pid: 2147483647 }))
  RunTracker.expectExit({ root: dir, component: "backend", runId: "old", pid: 2147483647 })
  const next = RunTracker.start({ root: dir, component: "cli" })
  expect(next.diagnostics).toHaveLength(0)
  expect(existsSync(tracker.marker)).toBe(true)
  expect(existsSync(join(state, name))).toBe(false)
  tracker.close()
  next.close()
})

test("cleanup removes old owned files but preserves live writers and unrelated files", async () => {
  const dir = root()
  const sink = new FileSink({ root: dir, component: "cli" })
  await sink.flush()
  const stale = join(sink.dir, "cli--2147483647--abcdef.ndjson")
  const dated = sink.file.replace(`--${process.pid}--`, "--2147483647--")
  const rotated = dated.replace(/\.ndjson$/, ".1.ndjson")
  const unrelated = join(sink.dir, "notes.txt")
  writeFileSync(stale, "old")
  writeFileSync(dated, "old")
  writeFileSync(rotated, "old")
  writeFileSync(unrelated, "keep")
  utimesSync(stale, 1, 1)
  utimesSync(dated, 1, 1)
  utimesSync(rotated, 1, 1)
  utimesSync(sink.file, 1, 1)
  pruneLogs(sink.dir, { days: 1 })
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(dated)).toBe(false)
  expect(existsSync(rotated)).toBe(false)
  expect(existsSync(unrelated)).toBe(true)
  expect(existsSync(sink.file)).toBe(true)
  await sink.close()
})

test("separate processes rotate concurrently without deleting each other's records", async () => {
  const dir = root()
  const module = pathToFileURL(join(import.meta.dirname, "node.ts")).href
  const results = await Promise.all(
    [0, 1, 2].map(async (writer) => {
      const source = `import { FileSink } from ${JSON.stringify(module)}; const sink = new FileSink({root:${JSON.stringify(dir)},component:"cli",rotate:{size:256,files:3}}); for(let i=0;i<100;i++)sink.write(JSON.stringify({writer:${writer},i})+"\\n"); await sink.close()`
      const { code, stderr } = await evaluate(source)
      expect(code, stderr).toBe(0)
    }),
  )
  expect(results).toHaveLength(3)
  const logs = readdirSync(join(dir, "production", "cli"))
  expect(logs).toHaveLength(9)
  const rows = logs.flatMap((file) =>
    readFileSync(join(dir, "production", "cli", file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  )
  expect([0, 1, 2].every((writer) => rows.some((row) => row.writer === writer && row.i === 99))).toBe(true)
})

test("accepts records without filesystem work and batches queued writes in order before close", async () => {
  const dir = root()
  const probe = await open(join(dir, "probe"), "ax")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const original = prototype.write as (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
  const sizes: number[] = []
  const writes = vi.spyOn(prototype, "write").mockImplementation(function (
    this: FileHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) {
    sizes.push(length)
    return original.call(this, buffer, offset, length, position)
  } as FileHandle["write"])
  const sink = new FileSink({ root: dir, component: "cli" })
  const expected = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({ index, value: "x".repeat(80) }) + "\n")
  try {
    const accepted = expected.map((line) => sink.write(line))
    expect(accepted).toEqual(expected.map((line) => Buffer.byteLength(line)))
    expect(existsSync(sink.dir)).toBe(false)
    expect(sizes).toHaveLength(0)
    const closed = sink.close()
    expect(sink.close()).toBe(closed)
    expect(sink.write('{"late":true}\n')).toBe(0)
    await closed
    expect(readFileSync(sink.file, "utf8")).toBe(expected.join(""))
    expect(statSync(sink.file).size).toBe(accepted.reduce((sum, bytes) => sum + bytes, 0))
    expect(sizes.length).toBeGreaterThan(1)
    expect(sizes.length).toBeLessThan(2_000)
    expect(sizes.every((bytes) => bytes <= 64 * 1024)).toBe(true)
  } finally {
    await sink.close()
    writes.mockRestore()
  }
})

test("flush is reusable while later concurrent producers preserve their acceptance order", async () => {
  const sink = new FileSink({ root: root(), component: "cli" })
  sink.write('{"index":0}\n')
  await sink.flush()
  expect(readFileSync(sink.file, "utf8")).toBe('{"index":0}\n')
  const expected = [0]
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      Promise.resolve().then(() => {
        const value = index + 1
        expected.push(value)
        sink.write(JSON.stringify({ index: value }) + "\n")
      }),
    ),
  )
  await sink.close()
  expect(
    readFileSync(sink.file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).index),
  ).toEqual(expected)
})

test("rejects overflow and accepts new records after flushing the backlog", async () => {
  const sink = new FileSink({ root: root(), component: "cli", bufferSize: 32 })
  expect(sink.write('{"index":0}\n')).toBe(12)
  expect(sink.write('{"index":1}\n')).toBe(12)
  expect(sink.write('{"index":2}\n')).toBe(0)
  await sink.flush()
  expect(sink.write('{"index":3}\n')).toBe(12)
  await sink.close()
  expect(readFileSync(sink.file, "utf8")).toBe('{"index":0}\n{"index":1}\n{"index":3}\n')
})

test("bounds tiny records by count and never queues empty input", async () => {
  const sink = new FileSink({ root: root(), component: "cli", bufferRecords: 2 })
  expect(sink.write("")).toBe(0)
  expect(sink.write("a")).toBe(1)
  expect(sink.write("b")).toBe(1)
  expect(sink.write("c")).toBe(0)
  await sink.close()
  expect(readFileSync(sink.file, "utf8")).toBe("ab")
})

test("writes large records completely before rotation without splitting JSON rows across files", async () => {
  const sink = new FileSink({ root: root(), component: "cli", rotate: { size: 110_000, files: 2 } })
  const first = JSON.stringify({ index: 0, value: "x".repeat(100_000) }) + "\n"
  const second = JSON.stringify({ index: 1, value: "x".repeat(40_000) }) + "\n"
  expect(sink.write(first)).toBe(Buffer.byteLength(first))
  expect(sink.write(second)).toBe(Buffer.byteLength(second))
  await sink.close()
  expect(readFileSync(sink.file.replace(/\.ndjson$/, ".1.ndjson"), "utf8")).toBe(first)
  expect(readFileSync(sink.file, "utf8")).toBe(second)
})

test("retries partial asynchronous writes to the real file without losing multibyte data", async () => {
  const dir = root()
  const probe = await open(join(dir, "probe"), "ax")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const original = prototype.write as (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
  let calls = 0
  const partial = vi.spyOn(prototype, "write").mockImplementation(function (
    this: FileHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) {
    calls++
    return original.call(this, buffer, offset, Math.min(length, 7), position)
  } as FileHandle["write"])
  const sink = new FileSink({ root: dir, component: "cli" })
  const line = JSON.stringify({ text: "中文 😀".repeat(20) }) + "\n"
  try {
    sink.write(line)
    sink.write(line)
    await sink.close()
    expect(readFileSync(sink.file, "utf8")).toBe(line.repeat(2))
    expect(calls).toBeGreaterThan(2)
    expect(statSync(sink.file).size).toBe(Buffer.byteLength(line) * 2)
  } finally {
    await sink.close()
    partial.mockRestore()
  }
})

test("a pending file write leaves timers responsive and keeps flush waiting for accepted records", async () => {
  const dir = root()
  const probe = await open(join(dir, "probe"), "ax")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const original = prototype.write as (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const delayed = vi.spyOn(prototype, "write").mockImplementation(function (
    this: FileHandle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) {
    entered.resolve()
    return release.promise.then(() => original.call(this, buffer, offset, length, position))
  } as FileHandle["write"])
  const sink = new FileSink({ root: dir, component: "cli" })
  const lines = '{"index":0}\n{"index":1}\n'
  let flushed = false
  try {
    expect(sink.write('{"index":0}\n')).toBe(12)
    expect(sink.write('{"index":1}\n')).toBe(12)
    const flushing = sink.flush().then(() => {
      flushed = true
    })
    await entered.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
    expect(readFileSync(sink.file, "utf8")).toBe("")
    release.resolve()
    await flushing
    await sink.close()
    expect(flushed).toBe(true)
    expect(readFileSync(sink.file, "utf8")).toBe(lines)
    expect(statSync(sink.file).size).toBe(Buffer.byteLength(lines))
  } finally {
    release.resolve()
    await sink.close()
    delayed.mockRestore()
  }
})

test("an unavailable directory abandons queued records and never rejects flush or close", async () => {
  const dir = root()
  const blocked = join(dir, "blocked")
  writeFileSync(blocked, "file")
  const sink = new FileSink({ root: blocked, component: "cli" })
  expect(sink.write('{"index":0}\n')).toBe(12)
  await sink.flush()
  expect(sink.write('{"index":1}\n')).toBe(0)
  await sink.close()
  expect(readFileSync(blocked, "utf8")).toBe("file")
})

test("a rotation failure releases the backlog and remains a logging side effect", async () => {
  const sink = new FileSink({ root: root(), component: "cli", rotate: { size: 20, files: 2 } })
  sink.write('{"index":0}\n')
  await sink.flush()
  mkdirSync(sink.file.replace(/\.ndjson$/, ".1.ndjson"))
  expect(sink.write('{"index":1}\n')).toBe(12)
  await sink.close()
  expect(sink.write('{"index":2}\n')).toBe(0)
  expect(readFileSync(sink.file, "utf8")).toBe('{"index":0}\n')
})

test("asynchronous initialization prunes stale logs without reading or deleting unrelated files", async () => {
  const dir = root()
  const logs = join(dir, "production", "cli")
  mkdirSync(logs, { recursive: true })
  const stale = join(logs, "cli--2147483647--abcdef.ndjson")
  const unrelated = join(logs, "notes.txt")
  writeFileSync(stale, "stale")
  writeFileSync(unrelated, "keep")
  utimesSync(stale, 1, 1)
  const sink = new FileSink({ root: dir, component: "cli", retention: { days: 1, bytes: 1_024, count: 10 } })
  sink.write('{"fresh":true}\n')
  await sink.close()
  expect(existsSync(stale)).toBe(false)
  expect(readFileSync(unrelated, "utf8")).toBe("keep")
  expect(readFileSync(sink.file, "utf8")).toBe('{"fresh":true}\n')
})
