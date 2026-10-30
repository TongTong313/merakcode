import { expect, test } from "vitest"
import path from "path"
import { pathToFileURL } from "url"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { evaluate, tmpdir } from "../fixture/fixture"

/**
 * Earlier versions kept the global config in ~/.config/merakcode and credentials in ~/.local/share/merakcode. A new
 * default root takes them over once at engine startup; a root moved by MERAKCODE_HOME starts empty.
 */
async function start(home: string, root?: string, debug = false) {
  const source = pathToFileURL(path.join(import.meta.dirname, "../../src/infra/global/index.ts")).href
  const host = pathToFileURL(path.join(import.meta.dirname, "../../src/app/host/index.ts")).href
  const child = Process.spawn(
    evaluate(
      debug
        ? `const { EngineHost } = await import(${JSON.stringify(host)}); await (await EngineHost.debug.scrap()).run(); await EngineHost.cleanup(); process.exit(0)`
        : `const { Global } = await import(${JSON.stringify(source)}); await Global.initialize()`,
    ),
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MERAKCODE_TEST_HOME: home,
        MERAKCODE_HOME: root ?? "",
        MERAKCODE_LOG_ROOT: path.join(home, "logs"),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
}

async function legacy(home: string) {
  await Filesystem.write(path.join(home, ".config", "merakcode", "merakcode.json"), '{"model":"legacy/model"}')
  await Filesystem.write(path.join(home, ".config", "merakcode", "AGENTS.md"), "legacy rules")
  await Filesystem.write(path.join(home, ".local", "share", "merakcode", "auth.json"), '{"legacy":true}')
}

test.each(["paths", "openapi"])("reading %s does not initialize directories or clear an old cache", async (entry) => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "root")
  await Filesystem.write(path.join(root, "cache", "version"), "0")
  await Filesystem.write(path.join(root, "cache", "keep"), "untouched")
  const source = pathToFileURL(path.join(import.meta.dirname, "../../src/infra/global/index.ts")).href
  const host = pathToFileURL(path.join(import.meta.dirname, "../../src/app/host/index.ts")).href
  const result = await Process.run(
    evaluate(`
    await import(${JSON.stringify(source)})
    if (${JSON.stringify(entry)} === "openapi") {
      const { EngineHost } = await import(${JSON.stringify(host)})
      await EngineHost.openapi()
    }
    const fs = await import("node:fs")
    const root = process.env.MERAKCODE_HOME
    console.log(JSON.stringify({
      version: fs.readFileSync(root + "/cache/version", "utf8"),
      sentinel: fs.readFileSync(root + "/cache/keep", "utf8"),
      initialized: fs.existsSync(root + "/data")
    }))
    process.exit(0)
  `),
    { env: { ...process.env, MERAKCODE_HOME: root }, nothrow: true },
  )
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(JSON.parse(result.text())).toEqual({ version: "0", sentinel: "untouched", initialized: false })
})

test("the first debug command initializes legacy config before opening storage", async () => {
  await using tmp = await tmpdir()
  await legacy(tmp.path)
  await start(tmp.path, undefined, true)
  const root = path.join(tmp.path, ".merakcode")
  expect(await Filesystem.readText(path.join(root, "merakcode.json"))).toBe('{"model":"legacy/model"}')
  expect(await Filesystem.readText(path.join(root, "data", "auth.json"))).toBe('{"legacy":true}')
})

test("a new default root takes over the old global config and credentials without overwriting", async () => {
  await using tmp = await tmpdir()
  await legacy(tmp.path)
  const root = path.join(tmp.path, ".merakcode")
  await Filesystem.write(path.join(root, "merakcode.json"), '{"model":"kept/model"}')

  await start(tmp.path)
  expect(await Filesystem.readText(path.join(root, "merakcode.json"))).toBe('{"model":"kept/model"}')
  expect(await Filesystem.readText(path.join(root, "AGENTS.md"))).toBe("legacy rules")
  expect(await Filesystem.readText(path.join(root, "data", "auth.json"))).toBe('{"legacy":true}')

  // Only a root without data/ is new: later starts copy nothing again
  await Filesystem.write(path.join(tmp.path, ".config", "merakcode", "AGENTS.md"), "changed later")
  await start(tmp.path)
  expect(await Filesystem.readText(path.join(root, "AGENTS.md"))).toBe("legacy rules")
})

test("a root moved by MERAKCODE_HOME starts empty", async () => {
  await using tmp = await tmpdir()
  await legacy(tmp.path)
  const root = path.join(tmp.path, "elsewhere")

  await start(tmp.path, root)
  expect(await Filesystem.isFile(path.join(root, "merakcode.json"))).toBe(false)
  expect(await Filesystem.isFile(path.join(root, "AGENTS.md"))).toBe(false)
  expect(await Filesystem.isFile(path.join(root, "data", "auth.json"))).toBe(false)
  expect(await Filesystem.isDir(path.join(root, "data"))).toBe(true)
})
