import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { filterRun, listRuns, readRecords } from "./inspect"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root() {
  const value = mkdtempSync(join(tmpdir(), "merakcode-inspect-"))
  roots.push(value)
  return value
}

const line = (run: string, sequence: number, message: string) =>
  JSON.stringify({
    schema: "merakcode.log.v1",
    timestamp: `2026-10-20T00:00:0${sequence}.000Z`,
    level: "INFO",
    component: "cli",
    service: "test",
    message,
    run_id: run,
    sequence,
    pid: 100,
  }) + "\n"

function write(dir: string, name: string, content: string, seconds: number) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content)
  utimesSync(file, seconds, seconds)
  return file
}

describe("listRuns", () => {
  test("finds runs in every component, newest first, with their run id from the first record", () => {
    const dir = root()
    write(
      join(dir, "production", "cli"),
      "main--2026-10-20T00-00-00-000Z--100--a1.ndjson",
      line("run-old", 1, "a"),
      1000,
    )
    write(
      join(dir, "production", "server"),
      "backend--2026-10-20T00-00-01-000Z--200--b2.ndjson",
      line("run-new", 1, "b"),
      2000,
    )
    write(join(dir, "diagnostics"), "1-x-abnormal_exit.json", "{}", 3000)
    const runs = listRuns(dir)
    expect(runs.map((run) => [run.id, run.component, run.name, run.pid, run.mode])).toEqual([
      ["run-new", "server", "backend", 200, "production"],
      ["run-old", "cli", "main", 100, "production"],
    ])
  })

  test("rotated files belong to the same run, oldest first", () => {
    const dir = root()
    const cli = join(dir, "development", "cli")
    write(cli, "main--2026-10-20T00-00-00-000Z--100--a1.2.ndjson", line("run-a", 1, "first"), 1000)
    write(cli, "main--2026-10-20T00-00-00-000Z--100--a1.1.ndjson", line("run-a", 2, "second"), 1001)
    write(cli, "main--2026-10-20T00-00-00-000Z--100--a1.ndjson", line("run-a", 3, "third"), 1002)
    const [run] = listRuns(dir)
    expect(run!.files.map((file) => file.slice(cli.length + 1))).toEqual([
      "main--2026-10-20T00-00-00-000Z--100--a1.2.ndjson",
      "main--2026-10-20T00-00-00-000Z--100--a1.1.ndjson",
      "main--2026-10-20T00-00-00-000Z--100--a1.ndjson",
    ])
    expect(run!.mode).toBe("development")
    expect(run!.started).toBe("2026-10-20T00:00:00.000Z")
  })

  test("a missing log directory has no runs", () => {
    expect(listRuns(join(root(), "nothing-here"))).toEqual([])
  })
})

describe("readRecords", () => {
  test("parses every line and skips broken ones", () => {
    const dir = root()
    const file = write(dir, "x.ndjson", line("r", 1, "ok") + "{not json\n" + line("r", 2, "also ok"), 1000)
    expect(readRecords(file).map((record) => record.message)).toEqual(["ok", "also ok"])
  })
})

describe("filterRun", () => {
  test("matches a run id by prefix and keeps the processes of one run together", () => {
    const dir = root()
    write(
      join(dir, "production", "cli"),
      "main--2026-10-20T00-00-00-000Z--100--a1.ndjson",
      line("abc123", 1, "m"),
      1000,
    )
    write(
      join(dir, "production", "cli"),
      "backend--2026-10-20T00-00-00-000Z--101--a2.ndjson",
      line("abc123", 1, "b"),
      1001,
    )
    write(
      join(dir, "production", "cli"),
      "main--2026-10-20T00-00-01-000Z--102--a3.ndjson",
      line("zzz999", 1, "x"),
      1002,
    )
    expect(
      filterRun(listRuns(dir), "abc")
        .map((run) => run.name)
        .sort(),
    ).toEqual(["backend", "main"])
    expect(filterRun(listRuns(dir), "nope")).toEqual([])
  })
})
