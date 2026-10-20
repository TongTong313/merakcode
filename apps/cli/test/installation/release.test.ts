import { afterEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Http } from "@merakcode/util/http"
import { Release } from "../../src/cli/installation/release"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-test-"))
  dirs.push(dir)
  return dir
}

// The system bsdtar can create tar.gz and zip (bundled since Windows 10)
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot!, "System32", "tar.exe") : "tar"

/** Builds a release archive whose launcher prints its version */
async function archive(dir: string, version: string) {
  const name = `merakcode-${version}-${Release.platform()}`
  const root = path.join(dir, "build", name)
  for (const entry of Release.commands) {
    const file = path.join(root, "bin", process.platform === "win32" ? `${entry}.cmd` : entry)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, process.platform === "win32" ? `@echo ${version}\r\n` : `#!/bin/sh\necho ${version}\n`, {
      mode: 0o755,
    })
  }
  const file = path.join(dir, "serve", `${name}.${Release.extension()}`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  execFileSync(tar, [process.platform === "win32" ? "-a" : "-z", "-cf", file, name], { cwd: path.dirname(root) })
  const sum = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
  await fs.appendFile(path.join(dir, "serve", "SHA256SUMS"), `${sum}  ${path.basename(file)}\n`)
}

async function serve(dir: string) {
  return Http.serve({
    fetch: async (request) => {
      const file = path.join(dir, "serve", decodeURIComponent(new URL(request.url).pathname))
      const data = await fs.readFile(file).catch(() => undefined)
      return data ? new Response(data) : new Response("not found", { status: 404 })
    },
  })
}

const run = (file: string) =>
  execFileSync(
    process.platform === "win32" ? "cmd" : "sh",
    process.platform === "win32" ? ["/c", file] : ["-c", file],
    {
      encoding: "utf8",
    },
  ).trim()

describe("Release.install", () => {
  test("downloads, verifies and extracts to versions/<version>, and links the command to that version", async () => {
    const dir = await temp()
    await archive(dir, "1.0.0")
    await using server = await serve(dir)
    const layout = { home: path.join(dir, "home"), bin: path.join(dir, "bin") }
    await Release.install("1.0.0", { base: server.url.href, layout })
    expect(await fs.readdir(path.join(layout.home, "versions"))).toEqual(["1.0.0"])
    expect(await fs.readdir(layout.bin)).toEqual([process.platform === "win32" ? "merak.cmd" : "merak"])
    expect(run(Release.command(layout, "merak"))).toBe("1.0.0")
    expect(Release.current(layout)).toBe("1.0.0")
  })

  test("after an upgrade the command points to the new version and only the new and previous ones remain (one rollback)", async () => {
    const dir = await temp()
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) await archive(dir, version)
    await using server = await serve(dir)
    const layout = { home: path.join(dir, "home"), bin: path.join(dir, "bin") }
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) await Release.install(version, { base: server.url.href, layout })
    expect(run(Release.command(layout, "merak"))).toBe("1.2.0")
    expect((await fs.readdir(path.join(layout.home, "versions"))).sort()).toEqual(["1.1.0", "1.2.0"])
  })

  test("a checksum mismatch installs nothing and leaves the current version intact", async () => {
    const dir = await temp()
    await archive(dir, "1.0.0")
    await archive(dir, "2.0.0")
    await using server = await serve(dir)
    const layout = { home: path.join(dir, "home"), bin: path.join(dir, "bin") }
    await Release.install("1.0.0", { base: server.url.href, layout })
    const sums = path.join(dir, "serve", "SHA256SUMS")
    await fs.writeFile(
      sums,
      (await fs.readFile(sums, "utf8")).replace(/^[0-9a-f]{64}(?=  merakcode-2\.0\.0)/m, "0".repeat(64)),
    )
    await expect(Release.install("2.0.0", { base: server.url.href, layout })).rejects.toThrow("校验")
    expect(run(Release.command(layout, "merak"))).toBe("1.0.0")
    expect(await fs.readdir(path.join(layout.home, "versions"))).toEqual(["1.0.0"])
  })
})
