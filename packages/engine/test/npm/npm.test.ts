import { describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import path from "node:path"
import { Npm } from "../../src/npm"
import { Process } from "@merakcode/util/process"
import { tmpdir } from "../fixture/fixture"

/** Local tgz package, so installs can be tested offline */
async function pack(root: string, name: string, version: string) {
  const dir = path.join(root, "src", `${name}-${version}`)
  await fs.mkdir(path.join(dir, "bin"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.js", bin: { [name]: "bin/cli.js" } }),
  )
  await fs.writeFile(path.join(dir, "index.js"), `module.exports = ${JSON.stringify(version)}\n`)
  await fs.writeFile(
    path.join(dir, "bin", "cli.js"),
    `#!/usr/bin/env node\nconsole.log("${name} " + process.argv.slice(2).join(" "))\n`,
  )
  const result = await Process.run([...Npm.command(), "pack", "--pack-destination", root], { cwd: dir })
  return path.join(root, result.text().trim().split("\n").at(-1)!)
}

/** A registry that accepts connections and never answers, so anything that waits on the registry hangs */
async function silentRegistry() {
  const sockets = new Set<Socket>()
  const server = createServer(() => {})
  server.on("connection", (socket) => sockets.add(socket))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

describe("Npm.command", () => {
  test("returns a command that runs npm", async () => {
    const result = await Process.run([...Npm.command(), "--version"])
    expect(result.text().trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("runs npm-cli.js from MERAKCODE_NPM_CLI with the current runtime", () => {
    const saved = process.env.MERAKCODE_NPM_CLI
    process.env.MERAKCODE_NPM_CLI = "/opt/npm/bin/npm-cli.js"
    try {
      expect(Npm.command()).toEqual([process.execPath, "/opt/npm/bin/npm-cli.js"])
    } finally {
      if (saved === undefined) delete process.env.MERAKCODE_NPM_CLI
      else process.env.MERAKCODE_NPM_CLI = saved
    }
  })
})

describe("Npm.install", () => {
  test("installs into the prefix, returns the package directory and records the exact version", async () => {
    await using dir = await tmpdir()
    const tarball = await pack(dir.path, "mc-probe", "1.2.3")
    const target = path.join(dir.path, "cache")
    const installed = await Npm.install(tarball, { prefix: target, name: "mc-probe" })
    expect(installed).toBe(path.join(target, "node_modules", "mc-probe"))
    expect(require(installed)).toBe("1.2.3")
    const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8"))
    expect(Object.keys(manifest.dependencies)).toEqual(["mc-probe"])
  }, 60_000)

  test("throws InstallFailedError with the package name and npm's error on failure", async () => {
    await using dir = await tmpdir()
    const missing = path.join(dir.path, "does-not-exist.tgz")
    const error = await Npm.install(missing, { prefix: path.join(dir.path, "cache"), name: "x" }).catch((e) => e)
    expect(Npm.InstallFailedError.isInstance(error)).toBe(true)
    expect(error.data.pkg).toBe("x")
    expect(String(error.cause?.message)).not.toBe("")
  }, 60_000)
})

describe("Npm.exec", () => {
  // After installing into the npx cache, npm waits for an audit report from the registry before running the bin,
  // unless auditing is off. Formatters and language servers start through Npm.exec, so a slow registry stalled them.
  test("runs the package's CLI and passes arguments through without waiting on the registry", async () => {
    await using dir = await tmpdir()
    await using registry = await silentRegistry()
    const tarball = await pack(dir.path, "mc-tool", "0.0.1")
    const result = await Process.run([...Npm.exec(tarball, "mc-tool"), "hello", "world"], {
      cwd: dir.path,
      env: { ...process.env, npm_config_registry: registry.url },
      timeout: 30_000,
    })
    expect(result.text().trim().split("\n").at(-1)).toBe("mc-tool hello world")
  }, 60_000)
})

describe("Npm.entry", () => {
  /** Writes a package under dir and returns its directory */
  async function local(dir: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>) {
    const root = path.join(dir, "node_modules", name)
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), content)
    }
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name, ...manifest }))
    return root
  }

  // Node cannot import a directory, and on Windows it rejects absolute paths like C:\; only file:// URLs work
  test("returns an importable file:// URL, picking the ESM entry via the exports import condition", async () => {
    await using dir = await tmpdir()
    const root = await local(
      dir.path,
      "dual",
      { exports: { ".": { import: "./esm/index.mjs", require: "./cjs/index.cjs" } } },
      { "esm/index.mjs": "export const kind = 'esm'\n", "cjs/index.cjs": "exports.kind = 'cjs'\n" },
    )
    const url = await Npm.entry(root)
    expect(url.startsWith("file://")).toBe(true)
    expect((await import(url)).kind).toBe("esm")
  })

  test("without exports uses module, then main, and resolves main without an extension", async () => {
    await using dir = await tmpdir()
    const withModule = await local(
      dir.path,
      "with-module",
      { module: "lib/m.mjs", main: "lib/c.js" },
      {
        "lib/m.mjs": "export const kind = 'module'\n",
        "lib/c.js": "exports.kind = 'main'\n",
      },
    )
    const bareMain = await local(
      dir.path,
      "bare-main",
      { main: "lib/entry" },
      { "lib/entry.js": "exports.kind = 'bare'\n" },
    )
    const noMain = await local(dir.path, "no-main", {}, { "index.js": "exports.kind = 'index'\n" })
    expect((await import(await Npm.entry(withModule))).kind).toBe("module")
    expect((await import(await Npm.entry(bareMain))).default.kind).toBe("bare")
    expect((await import(await Npm.entry(noMain))).default.kind).toBe("index")
  })

  test("converts a file path or file:// URL directly", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "tool.mjs")
    await fs.writeFile(file, "export const kind = 'file'\n")
    expect((await import(await Npm.entry(file))).kind).toBe("file")
    expect(await Npm.entry(await Npm.entry(file))).toBe(await Npm.entry(file))
  })
})
