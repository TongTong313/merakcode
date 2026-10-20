/**
 * merak plugin: add writes the project config, remove deletes by name, list shows plugins and their status
 */
import { expect, test } from "vitest"
import path from "path"
import { pathToFileURL } from "url"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function merak(cwd: string, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_MODELS_FETCH: "1" },
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

test(
  "add writes the project config, remove deletes by name and reports a missing plugin",
  { timeout: 120_000 },
  async () => {
    await using tmp = await tmpdir({ config: {} })
    const config = () =>
      Filesystem.readJson(path.join(tmp.path, "merakcode.json")).then((x) => x as { plugin?: string[] })

    // A local file plugin, so nothing is downloaded from npm
    const plugin = pathToFileURL(path.join(tmp.path, "demo.js")).href
    const added = await merak(tmp.path, "plugin", "add", plugin)
    expect(added.output).toContain(`Added plugin: ${plugin}`)
    expect((await config()).plugin).toEqual([plugin])

    const removed = await merak(tmp.path, "plugin", "remove", "demo")
    expect(removed.output).toContain("Removed plugin: demo")
    expect((await config()).plugin).toEqual([])

    const missing = await merak(tmp.path, "plugin", "remove", "nope")
    expect(missing.output).toContain("Plugin not found: nope")
    expect(missing.output).not.toContain("Removed plugin")
  },
)

test("list --json shows project plugins and their status", { timeout: 60_000 }, async () => {
  await using tmp = await tmpdir()
  await Filesystem.write(path.join(tmp.path, ".merakcode", "plugin", "hello.ts"), "export default async () => ({})\n")
  const result = await merak(tmp.path, "plugin", "list", "--json")
  expect(result.code, result.output).toBe(0)
  const plugins = JSON.parse(result.stdout) as { id: string; source: string; status: string }[]
  expect(plugins).toEqual([expect.objectContaining({ source: "config", status: "active" })])
})
