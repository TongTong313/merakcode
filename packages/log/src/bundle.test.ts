import { afterEach, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import { createBundle } from "./bundle"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root() {
  const value = mkdtempSync(join(tmpdir(), "merakcode-bundle-"))
  roots.push(value)
  return value
}

function run(dir: string, id: string, seconds: number, attributes: Record<string, unknown> = {}) {
  const folder = join(dir, "production", "cli")
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `main--2026-10-20T00-00-0${seconds % 10}-000Z--${100 + seconds}--${id}.ndjson`)
  const record = {
    schema: "merakcode.log.v1",
    timestamp: "2026-10-20T00:00:00.000Z",
    level: "ERROR",
    component: "cli",
    service: "test",
    message: `run ${id}`,
    run_id: id,
    sequence: 1,
    pid: 100 + seconds,
    attributes,
  }
  writeFileSync(file, JSON.stringify(record) + "\n")
  utimesSync(file, seconds, seconds)
}

async function entries(file: string) {
  const reader = new ZipReader(new BlobReader(new Blob([readFileSync(file)])))
  const result = new Map<string, string>()
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) result.set(entry.filename, await entry.getData!(new TextWriter()))
  }
  await reader.close()
  return result
}

test("the zip holds a manifest, recent logs with secrets removed, and the extra files", async () => {
  const dir = root()
  run(dir, "old", 1)
  run(dir, "mid", 2)
  run(dir, "new", 3, { apiKey: "sk-123", note: "Authorization: Bearer abc.def" })
  mkdirSync(join(dir, "diagnostics"), { recursive: true })
  writeFileSync(join(dir, "diagnostics", "1-x-abnormal_exit.json"), JSON.stringify({ type: "abnormal_exit" }))
  const out = join(root(), "nested", "report.zip")

  const result = await createBundle({
    root: dir,
    out,
    maxRuns: 2,
    extra: { "doctor.json": { ok: true }, "config.json": { provider: { openai: { options: { apiKey: "sk-999" } } } } },
  })

  expect(result.file).toBe(out)
  const files = await entries(out)
  expect([...files.keys()].sort()).toEqual([
    "config.json",
    "diagnostics/1-x-abnormal_exit.json",
    "doctor.json",
    "logs/production/cli/main--2026-10-20T00-00-02-000Z--102--mid.ndjson",
    "logs/production/cli/main--2026-10-20T00-00-03-000Z--103--new.ndjson",
    "manifest.json",
  ])
  const all = [...files.values()].join("\n")
  expect(all).not.toContain("sk-123")
  expect(all).not.toContain("sk-999")
  expect(all).not.toContain("abc.def")
  expect(files.get("logs/production/cli/main--2026-10-20T00-00-03-000Z--103--new.ndjson")).toContain("<redacted>")
  const manifest = JSON.parse(files.get("manifest.json")!)
  expect(manifest.schema).toBe("merakcode.bug-report.v1")
  expect(manifest.runs.map((item: { id: string }) => item.id)).toEqual(["new", "mid"])
})

test("an empty log directory still gives a zip with the manifest and extra files", async () => {
  const out = join(root(), "report.zip")
  await createBundle({ root: join(root(), "missing"), out, extra: { "doctor.json": [] } })
  expect([...(await entries(out)).keys()].sort()).toEqual(["doctor.json", "manifest.json"])
})
