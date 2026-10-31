import { expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Config } from "../../src/app/config/files/config"
import { tmpdir, evaluate, globalConfig } from "../fixture/fixture"
import { Process } from "@merakcode/util/process"
import { Instance } from "../../src/infra/project/instance"

test("a removed configuration directory does not reject background initialization", async () => {
  await using tmp = await tmpdir()
  await fs.rm(tmp.path, { recursive: true, force: true })
  await expect(Config.installDependencies(tmp.path)).resolves.toBeUndefined()
})

test("an interrupted installation restores a user's partially removed SDK", async () => {
  await using tmp = await tmpdir()
  const sdk = path.join(tmp.path, "node_modules/@merakcode/sdk")
  const backup = path.join(tmp.path, ".merakcode-sdk-preserved")
  const manifest = JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9", type: "module" })
  await fs.mkdir(sdk, { recursive: true })
  await fs.writeFile(path.join(sdk, "package.json"), manifest)
  await fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(tmp.path, "node_modules/zod"), {
    recursive: true,
  })
  await fs.mkdir(path.join(backup, "sdk"), { recursive: true })
  await fs.writeFile(path.join(backup, "sdk/package.json"), manifest)
  await fs.writeFile(path.join(backup, "sdk/plugin.js"), 'export const original = "user-sdk"')
  await fs.writeFile(path.join(backup, "ready"), "ready")
  await Config.installDependencies(tmp.path)
  const plugin = pathToFileURL(path.join(sdk, "plugin.js")).href
  const result = await Process.run(evaluate(`console.log((await import(${JSON.stringify(plugin)})).original)`))
  expect(result.text().trim()).toBe("user-sdk")
  await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" })
})

test("normal startup restores a user's SDK even when the replacement shim and zod are current", async () => {
  await using tmp = await tmpdir()
  using _global = globalConfig(tmp.path)
  await fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(tmp.path, "node_modules/zod"), {
    recursive: true,
  })
  await Config.installDependencies(tmp.path)
  const backup = path.join(tmp.path, ".merakcode-sdk-preserved")
  await fs.mkdir(path.join(backup, "sdk"), { recursive: true })
  await fs.writeFile(
    path.join(backup, "sdk/package.json"),
    JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9", type: "module" }),
  )
  await fs.writeFile(path.join(backup, "sdk/plugin.js"), 'export const original = "user-sdk"')
  await fs.writeFile(path.join(backup, "ready"), "ready")
  const project = path.join(tmp.path, "project")
  await fs.mkdir(project)
  await Instance.provide({
    directory: project,
    fn: async () => {
      await Config.get()
      await Config.waitForDependencies()
    },
  })
  const plugin = pathToFileURL(path.join(tmp.path, "node_modules/@merakcode/sdk/plugin.js")).href
  const result = await Process.run(evaluate(`console.log((await import(${JSON.stringify(plugin)})).original)`))
  expect(result.text().trim()).toBe("user-sdk")
  await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" })
})

test("a failed SDK backup lets background initialization and its process finish", async () => {
  await using tmp = await tmpdir()
  const sdk = path.join(tmp.path, "node_modules/@merakcode/sdk")
  await fs.mkdir(sdk, { recursive: true })
  await fs.writeFile(path.join(sdk, "package.json"), JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9" }))
  const result = await Process.run(
    evaluate(`
      import fs from "node:fs/promises"
      const { Config } = await import(${JSON.stringify(new URL("../../src/app/config/files/config.ts", import.meta.url).href)})
      // Inject an OS copy failure at the filesystem boundary, without replacing configuration collaborators.
      fs.cp = async () => { throw Object.assign(new Error("Copy denied"), { code: "EACCES" }) }
      await Config.installDependencies(${JSON.stringify(tmp.path)})
      console.log("initialization returned")
    `),
    { timeout: 10_000, nothrow: true },
  )
  expect(result.text().trim()).toBe("initialization returned")
  expect(result.exitCode).toBe(0)
})

test("retrying after partial backup cleanup preserves the restored user SDK", async () => {
  await using tmp = await tmpdir()
  const sdk = path.join(tmp.path, "node_modules/@merakcode/sdk")
  const backup = path.join(tmp.path, ".merakcode-sdk-preserved")
  await fs.mkdir(sdk, { recursive: true })
  await fs.writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9", type: "module" }),
  )
  await fs.writeFile(path.join(sdk, "plugin.js"), 'export const original = "user-sdk"')
  await fs.writeFile(
    path.join(tmp.path, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { zod: `file:${path.dirname(fileURLToPath(import.meta.resolve("zod"))).replaceAll("\\", "/")}` },
    }),
  )
  const first = await Process.run(
    evaluate(`
      import fs from "node:fs/promises"
      import path from "node:path"
      const { Config } = await import(${JSON.stringify(new URL("../../src/app/config/files/config.ts", import.meta.url).href)})
      const backup = ${JSON.stringify(backup)}
      const remove = fs.rm
      let injected = false
      // Model an interrupted recursive cleanup at the filesystem boundary, after installation has restored the SDK.
      fs.rm = async (target, options) => {
        if (!injected && String(target) === backup && await fs.stat(path.join(backup, "sdk")).catch(() => false)) {
          injected = true
          await remove(path.join(backup, "sdk/plugin.js"))
          throw Object.assign(new Error("Partial cleanup denied"), { code: "EACCES" })
        }
        return remove(target, options)
      }
      try {
        await Config.installDependencies(${JSON.stringify(tmp.path)})
      } finally { fs.rm = remove }
      console.log(injected)
    `),
    { env: { npm_config_offline: "true", npm_config_cache: path.join(tmp.path, "cache") } },
  )
  expect(first.text().trim()).toBe("true")
  const plugin = pathToFileURL(path.join(sdk, "plugin.js")).href
  const readPlugin = () => Process.run(evaluate(`console.log((await import(${JSON.stringify(plugin)})).original)`))
  expect((await readPlugin()).text().trim()).toBe("user-sdk")
  await Config.installDependencies(tmp.path)
  expect((await readPlugin()).text().trim()).toBe("user-sdk")
})

test.each(["instances", "processes", "incomplete dependencies", "partial package"])(
  "concurrent %s share one completed dependency installation",
  async (kind) => {
    await using tmp = await tmpdir()
    const cli = path.join(tmp.path, "npm.mjs")
    const installed = path.join(tmp.path, "installed")
    const gate = path.join(tmp.path, "continue")
    const calls = path.join(tmp.path, "calls")
    await fs.mkdir(installed)
    if (kind === "incomplete dependencies")
      await fs.mkdir(path.join(installed, "node_modules/zod"), { recursive: true })
    if (kind === "partial package") {
      await fs.mkdir(path.join(installed, "node_modules/zod"), { recursive: true })
      await fs.writeFile(
        path.join(installed, "node_modules/zod/package.json"),
        JSON.stringify({ name: "zod", main: "index.cjs" }),
      )
      await fs.writeFile(
        path.join(installed, "node_modules/zod/index.cjs"),
        'module.exports = require("./missing.cjs")',
      )
    }
    await fs.writeFile(
      cli,
      `
    import fs from "node:fs/promises"
    import path from "node:path"
    import { setTimeout as sleep } from "node:timers/promises"
    await fs.appendFile(${JSON.stringify(calls)}, "install\\n")
    while (!(await fs.stat(${JSON.stringify(gate)}).catch(() => false))) await sleep(10)
    await fs.cp(${JSON.stringify(path.dirname(fileURLToPath(import.meta.resolve("zod"))))}, path.join(process.cwd(), "node_modules/zod"), { recursive: true })
  `,
    )
    vi.stubEnv("MERAKCODE_NPM_CLI", cli)
    const start = (id: string) =>
      kind !== "processes"
        ? Config.installDependencies(installed)
        : Process.run(
            evaluate(`
    import fs from "node:fs/promises"
    const { Config } = await import(${JSON.stringify(new URL("../../src/app/config/files/config.ts", import.meta.url).href)})
    const task = Config.installDependencies(${JSON.stringify(installed)})
    await fs.writeFile(${JSON.stringify(path.join(tmp.path, id))}, "ready")
    await task
  `),
          )
    const first = start("first")
    try {
      await expect.poll(async () => fs.readFile(calls, "utf8"), { timeout: 10_000 }).toBe("install\n")
      const second = start("second")
      if (kind === "processes")
        await expect
          .poll(async () => fs.readFile(path.join(tmp.path, "second"), "utf8"), { timeout: 10_000 })
          .toBe("ready")
      await fs.writeFile(gate, "go")
      await Promise.all([first, second])
      expect(await fs.readFile(calls, "utf8")).toBe("install\n")
      const plugin = pathToFileURL(path.join(installed, "node_modules/@merakcode/sdk/plugin.js")).href
      const result = await Process.run(
        evaluate(
          `const { tool } = await import(${JSON.stringify(plugin)}); console.log(tool.schema.string().parse("ready"))`,
        ),
      )
      expect(result.text().trim()).toBe("ready")
    } finally {
      await fs.writeFile(gate, "go")
      await first
      vi.unstubAllEnvs()
    }
  },
)

test("dependency initialization recovers after its engine exits during installation", async () => {
  await using tmp = await tmpdir()
  const cli = path.join(tmp.path, "npm.mjs")
  const started = path.join(tmp.path, "started")
  const gate = path.join(tmp.path, "continue")
  const calls = path.join(tmp.path, "calls")
  const other = path.join(tmp.path, "other")
  await fs.mkdir(other)
  const sdk = path.join(tmp.path, "node_modules/@merakcode/sdk")
  await fs.mkdir(sdk, { recursive: true })
  await fs.writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9", type: "module" }),
  )
  await fs.writeFile(path.join(sdk, "plugin.js"), 'import { z } from "zod"; export const tool = { schema: z }')
  await fs.writeFile(
    cli,
    `
    import fs from "node:fs/promises"
    import path from "node:path"
    import { setTimeout as sleep } from "node:timers/promises"
    await fs.rm(path.join(process.cwd(), "node_modules/@merakcode/sdk"), { recursive: true, force: true })
    await fs.writeFile(${JSON.stringify(started)}, String(process.pid))
    await fs.appendFile(${JSON.stringify(calls)}, process.cwd() + "\\n")
    while (process.cwd() !== ${JSON.stringify(other)} && !(await fs.stat(${JSON.stringify(gate)}).catch(() => false))) await sleep(10)
    await fs.cp(${JSON.stringify(path.dirname(fileURLToPath(import.meta.resolve("zod"))))}, path.join(process.cwd(), "node_modules/zod"), { recursive: true })
  `,
  )
  vi.stubEnv("MERAKCODE_NPM_CLI", cli)
  const owner = Process.spawn(
    evaluate(`
    const { Config } = await import(${JSON.stringify(new URL("../../src/app/config/files/config.ts", import.meta.url).href)})
    await Config.installDependencies(${JSON.stringify(tmp.path)})
  `),
    { stderr: "pipe" },
  )
  let retry: Promise<void> | undefined
  try {
    await expect.poll(() => fs.readFile(started, "utf8"), { timeout: 10_000 }).toMatch(/^\d+$/)
    owner.kill()
    await owner.exited
    const npmPid = Number(await fs.readFile(started, "utf8"))
    if (process.platform === "win32")
      await expect
        .poll(() => {
          try {
            process.kill(npmPid, 0)
            return true
          } catch {
            return false
          }
        })
        .toBe(false)
    else process.kill(npmPid, 0)
    let complete = false
    retry = Config.installDependencies(tmp.path).then(() => {
      complete = true
    })
    await Config.installDependencies(other)
    expect(complete).toBe(false)
    if (process.platform !== "win32") process.kill(npmPid, 0)
    await fs.writeFile(gate, "go")
    await expect.poll(() => complete, { timeout: 10_000 }).toBe(true)
    expect((await fs.readFile(calls, "utf8")).split("\n").filter((dir) => dir === tmp.path)).toHaveLength(
      process.platform === "win32" ? 2 : 1,
    )
    expect(JSON.parse(await fs.readFile(path.join(sdk, "package.json"), "utf8")).version).toBe("9.9.9")
    const plugin = pathToFileURL(path.join(tmp.path, "node_modules/@merakcode/sdk/plugin.js")).href
    const result = await Process.run(
      evaluate(
        `const { tool } = await import(${JSON.stringify(plugin)}); console.log(tool.schema.string().parse("recovered"))`,
      ),
    )
    expect(result.text().trim()).toBe("recovered")
  } finally {
    owner.kill()
    await fs.writeFile(gate, "go")
    await retry
    vi.unstubAllEnvs()
  }
})

test("normal startup repairs a locked ESM dependency and preserves the user's SDK and other dependencies", async () => {
  await using tmp = await tmpdir()
  using _global = globalConfig(tmp.path)
  const zod = path.dirname(fileURLToPath(import.meta.resolve("zod")))
  await fs.cp(zod, path.join(tmp.path, "package"), { recursive: true })
  const archive = path.join(tmp.path, "zod.tgz")
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot!, "System32/tar.exe") : "tar"
  await Process.run([tar, "-czf", archive, "-C", tmp.path, "package"])
  const other = path.join(tmp.path, "preserved-dependency")
  await fs.mkdir(other)
  await fs.writeFile(
    path.join(other, "package.json"),
    JSON.stringify({ name: "preserved-dependency", version: "1.0.0", type: "module", exports: "./index.js" }),
  )
  await fs.writeFile(path.join(other, "index.js"), 'export const sentinel = "preserved"')
  const sdk = path.join(tmp.path, "node_modules/@merakcode/sdk")
  await fs.mkdir(sdk, { recursive: true })
  await fs.writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({
      name: "@merakcode/sdk",
      version: "9.9.9",
      type: "module",
      exports: { "./plugin": "./plugin.js" },
    }),
  )
  await fs.writeFile(
    path.join(sdk, "plugin.js"),
    'import { z } from "zod"; export const original = "user-sdk"; export const tool = { schema: z }',
  )
  await fs.writeFile(
    path.join(tmp.path, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        zod: `file:${archive.replaceAll("\\", "/")}`,
        "preserved-dependency": `file:${other.replaceAll("\\", "/")}`,
      },
    }),
  )
  vi.stubEnv("npm_config_offline", "true")
  vi.stubEnv("npm_config_cache", path.join(tmp.path, "cache"))
  try {
    const readPlugin = async () => {
      const result = await Process.run(
        evaluate(`
          import { tool, original } from "@merakcode/sdk/plugin"
          import { sentinel } from "preserved-dependency"
          console.log(JSON.stringify({ original, sentinel, parsed: tool.schema.string().parse("ready") }))
        `),
        { cwd: tmp.path },
      )
      return JSON.parse(result.text())
    }
    await Config.installDependencies(tmp.path)
    expect(await readPlugin()).toEqual({ original: "user-sdk", sentinel: "preserved", parsed: "ready" })
    expect((await fs.lstat(path.join(tmp.path, "node_modules/zod"))).isSymbolicLink()).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(tmp.path, "package-lock.json"), "utf8"))).toHaveProperty(
      "packages.node_modules/zod",
    )
    await fs.unlink(path.join(tmp.path, "node_modules/zod/index.js"))
    const commonjs = await Process.run(
      evaluate(`
        import { createRequire } from "node:module"
        const { z } = createRequire(${JSON.stringify(path.join(tmp.path, "package.json"))})("zod")
        console.log(z.string().parse("ready"))
      `),
    )
    expect(commonjs.text().trim()).toBe("ready")
    const project = path.join(tmp.path, "project")
    await fs.mkdir(project)
    await Instance.provide({
      directory: project,
      fn: async () => {
        await Config.get()
        await Config.waitForDependencies()
      },
    })
    expect(await readPlugin()).toEqual({ original: "user-sdk", sentinel: "preserved", parsed: "ready" })
  } finally {
    vi.unstubAllEnvs()
  }
})

test("a real offline npm install leaves the plugin API usable", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(
    path.join(tmp.path, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { zod: `file:${path.dirname(fileURLToPath(import.meta.resolve("zod"))).replaceAll("\\", "/")}` },
    }),
  )
  vi.stubEnv("npm_config_offline", "true")
  try {
    await Config.installDependencies(tmp.path)
    const plugin = pathToFileURL(path.join(tmp.path, "node_modules/@merakcode/sdk/plugin.js")).href
    const result = await Process.run(
      evaluate(
        `const { tool } = await import(${JSON.stringify(plugin)}); console.log(tool.schema.string().parse("offline"))`,
      ),
    )
    expect(result.text().trim()).toBe("offline")
  } finally {
    vi.unstubAllEnvs()
  }
})

test("a failed offline npm lifecycle leaves the plugin API usable", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(
    path.join(tmp.path, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { zod: `file:${path.dirname(fileURLToPath(import.meta.resolve("zod"))).replaceAll("\\", "/")}` },
      scripts: { postinstall: "node fail.cjs" },
    }),
  )
  await fs.writeFile(
    path.join(tmp.path, "fail.cjs"),
    'require("node:fs").writeFileSync("postinstall-failed", "started"); process.exit(19)',
  )
  vi.stubEnv("npm_config_offline", "true")
  vi.stubEnv("npm_config_cache", path.join(tmp.path, "cache"))
  try {
    await Config.installDependencies(tmp.path)
    expect(await fs.readFile(path.join(tmp.path, "postinstall-failed"), "utf8")).toBe("started")
    const plugin = pathToFileURL(path.join(tmp.path, "node_modules/@merakcode/sdk/plugin.js")).href
    const result = await Process.run(
      evaluate(
        `const { tool } = await import(${JSON.stringify(plugin)}); console.log(tool.schema.string().parse("offline"))`,
      ),
    )
    expect(result.text().trim()).toBe("offline")
  } finally {
    vi.unstubAllEnvs()
  }
})

test("an npm install preserves a linked user SDK when its backing store is pruned", async () => {
  await using tmp = await tmpdir()
  const store = path.join(tmp.path, "store")
  const sdk = path.join(tmp.path, "node_modules/@merakcode/sdk")
  await fs.mkdir(store)
  await fs.mkdir(path.dirname(sdk), { recursive: true })
  await fs.writeFile(
    path.join(store, "package.json"),
    JSON.stringify({ name: "@merakcode/sdk", version: "9.9.9", type: "module" }),
  )
  await fs.writeFile(path.join(store, "plugin.js"), 'export const original = "linked-sdk"')
  await fs.symlink(store, sdk, process.platform === "win32" ? "junction" : "dir")
  await fs.writeFile(
    path.join(tmp.path, "prune.cjs"),
    'require("node:fs").rmSync("store", { recursive: true, force: true })',
  )
  await fs.writeFile(
    path.join(tmp.path, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { zod: `file:${path.dirname(fileURLToPath(import.meta.resolve("zod"))).replaceAll("\\", "/")}` },
      scripts: { postinstall: "node prune.cjs" },
    }),
  )
  vi.stubEnv("npm_config_offline", "true")
  try {
    await Config.installDependencies(tmp.path)
    await expect(fs.stat(store)).rejects.toMatchObject({ code: "ENOENT" })
    const plugin = pathToFileURL(path.join(sdk, "plugin.js")).href
    const result = await Process.run(evaluate(`console.log((await import(${JSON.stringify(plugin)})).original)`))
    expect(result.text().trim()).toBe("linked-sdk")
  } finally {
    vi.unstubAllEnvs()
  }
})
