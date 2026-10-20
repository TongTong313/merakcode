import { describe, expect, test } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import { Atomic } from "@merakcode/engine/file/atomic"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const posix = process.platform !== "win32"
const temporary = () => tmpdir({ dispose: (dir) => fs.rm(dir, { recursive: true, force: true }) })

describe("Atomic.write", () => {
  test("creates a new file", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "new.txt")
    await Atomic.write(file, "hello")
    expect(await Filesystem.readText(file)).toBe("hello")
  })

  test("overwrites an existing file", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "a.txt")
    await Filesystem.write(file, "old")
    await Atomic.write(file, "new")
    expect(await Filesystem.readText(file)).toBe("new")
  })

  test("creates missing parent directories", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "deep", "nested", "a.txt")
    await Atomic.write(file, "x")
    expect(await Filesystem.readText(file)).toBe("x")
  })

  test("leaves no temporary file behind", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "a.txt")
    await Atomic.write(file, "content")
    const entries = await fs.readdir(tmp.path)
    expect(entries).toEqual(["a.txt"])
  })

  test("writes binary content", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "a.bin")
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    await Atomic.write(file, bytes)
    expect(await Filesystem.readBytes(file)).toEqual(bytes)
  })

  test.skipIf(!posix)("keeps the original file's executable bit", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "run.sh")
    await Filesystem.write(file, "#!/bin/sh\necho old")
    await fs.chmod(file, 0o755)
    await Atomic.write(file, "#!/bin/sh\necho new")
    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o755)
  })

  test.skipIf(!posix)("writes through a symlink target without replacing the link", async () => {
    await using tmp = await temporary()
    const real = path.join(tmp.path, "real.txt")
    const link = path.join(tmp.path, "link.txt")
    await Filesystem.write(real, "old")
    await fs.symlink(real, link)
    await Atomic.write(link, "new")
    expect(await Filesystem.readText(real)).toBe("new")
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  })

  test("concurrent writes to one path leave one complete payload, never a mix", async () => {
    await using tmp = await temporary()
    const file = path.join(tmp.path, "a.txt")
    const payloads = Array.from({ length: 10 }, (_, i) => String(i).repeat(5000))
    await Promise.all(payloads.map((p) => Atomic.write(file, p)))
    const got = await Filesystem.readText(file)
    expect(payloads).toContain(got)
    // All temporary files are cleaned up
    expect(await fs.readdir(tmp.path)).toEqual(["a.txt"])
  })
})
