/**
 * Session management subcommands (import, session list, export): runs the merak subcommands from source to import a
 * session into an isolated data directory, then list and export it with the same content; a missing file or session
 * is reported with a reason
 */
import { expect, test } from "vitest"
import path from "path"
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
  return { stdout, stderr, code }
}

/** The export output format: session info plus the complete messages */
function exported() {
  const sessionID = "ses_00000000000000000000000000"
  const user = "msg_user0000000000000000000"
  const assistant = "msg_asst0000000000000000000"
  const now = Date.now()
  return {
    info: {
      id: sessionID,
      slug: "import-export",
      projectID: "elsewhere",
      directory: "/elsewhere",
      title: "导入导出测试会话",
      version: "0.1.0",
      time: { created: now, updated: now },
    },
    messages: [
      {
        info: {
          id: user,
          sessionID,
          role: "user",
          time: { created: now },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
        },
        parts: [{ id: "prt_user000000000000000000", sessionID, messageID: user, type: "text", text: "你好" }],
      },
      {
        info: {
          id: assistant,
          sessionID,
          role: "assistant",
          time: { created: now },
          parentID: user,
          modelID: "claude-sonnet-5",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: "/elsewhere", root: "/elsewhere" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          { id: "prt_asst000000000000000000", sessionID, messageID: assistant, type: "text", text: "有什么可以帮你？" },
        ],
      },
    ],
  }
}

test(
  "an imported session belongs to the current project and can be listed and exported",
  { timeout: 90_000 },
  async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "export.json")
    await Filesystem.write(file, JSON.stringify(exported()))

    const imported = await merak(tmp.path, "import", file)
    expect(imported.code).toBe(0)
    const id = imported.stdout.match(/Imported session: (ses_\w+)/)?.[1]
    expect(id).toBeDefined()

    const listed = await merak(tmp.path, "session", "list", "--format", "json")
    expect(listed.code).toBe(0)
    const sessions = JSON.parse(listed.stdout) as { id: string; title: string; directory: string }[]
    expect(sessions.map((item) => [item.id, item.title])).toEqual([[id, "导入导出测试会话"]])
    expect(path.relative(tmp.path, sessions[0]!.directory)).toBe("")

    const result = await merak(tmp.path, "export", id!)
    expect(result.code).toBe(0)
    const data = JSON.parse(result.stdout) as { info: { id: string }; messages: { parts: { text?: string }[] }[] }
    expect(data.info.id).toBe(id)
    expect(data.messages.flatMap((item) => item.parts.map((part) => part.text))).toEqual(["你好", "有什么可以帮你？"])

    // --project without a value counts the current project
    const stats = await merak(tmp.path, "stats", "--project")
    expect(stats.code).toBe(0)
    expect(stats.stdout).toMatch(/│Sessions\s+1 │/)
    expect(stats.stdout).toMatch(/│Messages\s+2 │/)
  },
)

test("importing a missing file or exporting a missing session fails with a reason", { timeout: 90_000 }, async () => {
  await using tmp = await tmpdir()
  const missing = path.join(tmp.path, "missing.json")

  const imported = await merak(tmp.path, "import", missing)
  expect(imported.code).toBe(1)
  expect(imported.stdout).toContain(`File not found: ${missing}`)

  const result = await merak(tmp.path, "export", "ses_missing")
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Session not found: ses_missing")
})
