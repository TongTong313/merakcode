import { afterEach, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import { exportDiagnostics } from "../src/diagnostics"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root() {
  const value = mkdtempSync(join(tmpdir(), "desktop-diagnostics-"))
  roots.push(value)
  return value
}

test("writes a dated zip into the folder with app info and the desktop logs", async () => {
  const logs = root()
  const folder = join(logs, "production", "desktop")
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, "backend--2026-10-20T00-00-01-000Z--101--run.ndjson"),
    JSON.stringify({ message: "backend failed", run_id: "run", attributes: { token: "secret-token" } }) + "\n",
  )
  const out = root()

  const file = await exportDiagnostics({
    root: logs,
    dir: out,
    info: { version: "1.2.3", backend: "failed", error: "exited before it started listening" },
    now: new Date("2026-10-20T08:09:10Z"),
  })

  expect(basename(file)).toBe("merakcode-report-20261020-080910.zip")
  const reader = new ZipReader(new BlobReader(new Blob([readFileSync(file)])))
  const files = new Map<string, string>()
  for (const entry of await reader.getEntries())
    if (!entry.directory) files.set(entry.filename, await entry.getData!(new TextWriter()))
  await reader.close()
  expect(JSON.parse(files.get("app.json")!)).toMatchObject({ version: "1.2.3", backend: "failed" })
  expect(files.has("logs/production/desktop/backend--2026-10-20T00-00-01-000Z--101--run.ndjson")).toBe(true)
  expect([...files.values()].join("\n")).not.toContain("secret-token")
})
