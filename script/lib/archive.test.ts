import { afterEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { Archive } from "./archive"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function release() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"))
  dirs.push(dir)
  const root = path.join(dir, "merakcode-1.0.0-linux-x64")
  const deep = path.join(root, "lib", "node_modules", "@scope", "a-package-with-a-long-name", "dist", "nested", "again")
  await fs.mkdir(path.join(root, "bin"), { recursive: true })
  await fs.mkdir(deep, { recursive: true })
  await fs.writeFile(path.join(root, "bin", "merak"), "#!/bin/sh\necho hi\n")
  await fs.writeFile(path.join(root, "lib", "index.js"), "console.log('入口')\n")
  // Native binaries (ELF) and shebang scripts must stay executable even when packed on Windows
  await fs.writeFile(path.join(root, "lib", "helper"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
  await fs.writeFile(path.join(deep, "超过一百个字节的路径要用 pax 扩展头记下来.js"), "export {}\n")
  return { dir, root }
}

// The system bsdtar reads both tar.gz and zip (System32\tar.exe since Windows 10, tar on macOS)
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot!, "System32", "tar.exe") : "tar"
const list = (file: string) => execFileSync(tar, ["-tvf", file], { encoding: "utf8" })

describe("Archive.create", () => {
  test("tar paths remain valid UTF-8 in both standard and extended headers", async () => {
    const { dir, root } = await release()
    await fs.writeFile(path.join(root, "lib", "界".repeat(40) + ".js"), "export {}\n")
    const file = path.join(dir, "unicode.tar.gz")
    await Archive.create(root, file)
    const data = gunzipSync(await fs.readFile(file))
    const decoder = new TextDecoder("utf-8", { fatal: true })
    for (let at = 0; data[at];) {
      const header = data.subarray(at, at + 512)
      const name = header.subarray(0, 100)
      expect(() => decoder.decode(name.subarray(0, name.indexOf(0) < 0 ? 100 : name.indexOf(0)))).not.toThrow()
      const size = parseInt(header.toString("ascii", 124, 136), 8)
      at += 512 + Math.ceil(size / 512) * 512
    }
  })
  test("tar.gz: the directory is the top level; scripts and binaries are executable, other files are not", async () => {
    const { dir, root } = await release()
    const file = path.join(dir, "out.tar.gz")
    await Archive.create(root, file)
    const lines = list(file).split(/\r?\n/)
    const mode = (name: string) => lines.find((line) => line.endsWith(name))?.split(/\s+/)[0]
    expect(mode("merakcode-1.0.0-linux-x64/bin/merak")).toBe("-rwxr-xr-x")
    expect(mode("merakcode-1.0.0-linux-x64/lib/helper")).toBe("-rwxr-xr-x")
    expect(mode("merakcode-1.0.0-linux-x64/lib/index.js")).toBe("-rw-r--r--")
  })

  test.each(["tar.gz", "zip"])("%s extracted content keeps long paths and non-ASCII file names", async (ext) => {
    const { dir, root } = await release()
    const file = path.join(dir, `out.${ext}`)
    await Archive.create(root, file)
    const target = path.join(dir, "extracted")
    await Archive.extract(file, target)
    const back = path.join(target, path.basename(root))
    expect(await fs.readFile(path.join(back, "lib", "index.js"), "utf8")).toBe("console.log('入口')\n")
    const deep = path.join("lib", "node_modules", "@scope", "a-package-with-a-long-name", "dist", "nested", "again")
    expect(await fs.readdir(path.join(back, deep))).toEqual(["超过一百个字节的路径要用 pax 扩展头记下来.js"])
  })
})
