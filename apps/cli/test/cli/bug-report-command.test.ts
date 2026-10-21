/**
 * merak bug-report: one zip with the doctor results, recent logs and config, with secrets removed.
 */
import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

test("writes a zip without keys and says where to send it", { timeout: 120_000 }, async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "log")
  const logs = path.join(root, "production", "cli")
  await fs.mkdir(logs, { recursive: true })
  await fs.writeFile(
    path.join(logs, "main--2026-10-20T00-00-01-000Z--101--old-run.ndjson"),
    JSON.stringify({
      schema: "merakcode.log.v1",
      timestamp: "2026-10-20T00:00:01.000Z",
      level: "ERROR",
      component: "cli",
      service: "test",
      message: "request failed",
      run_id: "old-run",
      sequence: 1,
      pid: 101,
      attributes: { apiKey: "sk-123" },
    }) + "\n",
  )
  const config = path.join(tmp.path, "merakcode")
  await fs.mkdir(config, { recursive: true })
  await fs.writeFile(
    path.join(config, "merakcode.json"),
    JSON.stringify({ provider: { openai: { options: { apiKey: "sk-999" } } } }),
  )
  const out = path.join(tmp.path, "report.zip")

  const proc = Process.spawn([...cli, "bug-report", "--out", out], {
    cwd: tmp.path,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_LOG_ROOT: root, MERAKCODE_HOME: config },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code, stderr).toBe(0)
  expect(stdout).toContain(out)
  expect(stdout).toContain("https://github.com/TongTong313/merakcode/issues/new")

  const reader = new ZipReader(new BlobReader(new Blob([await fs.readFile(out)])))
  const files = new Map<string, string>()
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) files.set(entry.filename, await entry.getData!(new TextWriter()))
  }
  await reader.close()
  expect([...files.keys()]).toEqual(
    expect.arrayContaining([
      "manifest.json",
      "doctor.json",
      "config/global.json",
      "logs/production/cli/main--2026-10-20T00-00-01-000Z--101--old-run.ndjson",
    ]),
  )
  const all = [...files.values()].join("\n")
  expect(all).not.toContain("sk-123")
  expect(all).not.toContain("sk-999")
  expect(JSON.parse(files.get("doctor.json")!).map((check: { id: string }) => check.id)).toContain("engine")
})
