/**
 * merak export: JSON (imports back) or Markdown, to the terminal, a file, or one file per session with --all
 */
import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "path"
import { Identifier } from "@merakcode/util/id"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function merak(cwd: string, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_CATALOG_FETCH: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, output: stdout + stderr, code }
}

function session(text: string) {
  const sessionID = Identifier.descending("session")
  const messageID = Identifier.ascending("message")
  const now = Date.now()
  return {
    info: {
      id: sessionID,
      slug: "fixture",
      projectID: "fixture",
      directory: "/",
      title: "Export: a/b",
      version: "0.0.0",
      time: { created: now, updated: now },
    },
    messages: [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          time: { created: now },
        },
        parts: [{ id: Identifier.ascending("part"), sessionID, messageID, type: "text", text }],
      },
    ],
  }
}

test("exports as JSON to the terminal or a file and as Markdown for every session", { timeout: 120_000 }, async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "in.json")
  await Filesystem.write(file, JSON.stringify(session("EXPORT_MARKER_TEXT")))
  const imported = await merak(tmp.path, "import", file)
  const sessionID = imported.output.match(/Imported session: (\S+)/)?.[1]
  expect(sessionID, imported.output).toBeDefined()

  const printed = await merak(tmp.path, "export", sessionID!)
  expect(printed.code, printed.output).toBe(0)
  expect(JSON.parse(printed.stdout).messages[0].parts[0].text).toBe("EXPORT_MARKER_TEXT")

  const target = path.join(tmp.path, "out", "one.json")
  const written = await merak(tmp.path, "export", sessionID!, "--out", target)
  expect(written.output).toContain(`Wrote ${target}`)
  expect((await Filesystem.readJson(target)).info.id).toBe(sessionID)

  const folder = path.join(tmp.path, "all")
  const all = await merak(tmp.path, "export", "--all", "--format", "markdown", "--out", folder)
  expect(all.output).toContain(`Exported 1 sessions to ${folder}`)
  const files = await fs.readdir(folder)
  expect(files).toEqual([`Export a b-${sessionID!.slice(-8)}.md`])
  expect(await Filesystem.readText(path.join(folder, files[0]!))).toContain("EXPORT_MARKER_TEXT")

  const missing = await merak(tmp.path, "export", "--all")
  expect(missing.code).not.toBe(0)
})
