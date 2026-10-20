import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Filesystem } from "./filesystem"

describe("Filesystem.sameDirectory", () => {
  test("drive-letter case and slash direction do not matter", () => {
    expect(Filesystem.sameDirectory("D:\\code\\repo", "d:/code/repo")).toBe(true)
  })

  test("trailing slash does not matter (POSIX)", () => {
    expect(Filesystem.sameDirectory("/a/b/", "/a/b")).toBe(true)
  })

  test("trailing slash does not matter (Windows style)", () => {
    expect(Filesystem.sameDirectory("d:/code/repo", "d:/code/repo/")).toBe(true)
  })

  test("different directories stay different", () => {
    expect(Filesystem.sameDirectory("d:/code/repoA", "d:/code/repoB")).toBe(false)
  })

  test("a subdirectory is not the same as its parent", () => {
    expect(Filesystem.sameDirectory("d:/code/repo/sub", "d:/code/repo")).toBe(false)
  })

  test("case outside the drive letter is significant", () => {
    expect(Filesystem.sameDirectory("/home/u/proj", "/home/u/Proj")).toBe(false)
  })

  test("two empty strings are the same", () => {
    expect(Filesystem.sameDirectory("", "")).toBe(true)
  })

  // Storage.read skips zod validation, so old sessions may have an undefined directory. Throwing inside the filter
  // loop would make the whole list endpoint return 500, so undefined must return false (skip) instead.
  test("returns false without throwing when session.directory is undefined", () => {
    expect(Filesystem.sameDirectory(undefined as unknown as string, "d:/x")).toBe(false)
  })

  test("returns false without throwing when the query side is undefined", () => {
    expect(Filesystem.sameDirectory("d:/x", undefined as unknown as string)).toBe(false)
  })
})

describe("Filesystem.sameFilepath", () => {
  test.skipIf(process.platform !== "win32")("drive-letter case and slash direction do not matter", () => {
    expect(Filesystem.sameFilepath("D:\\code\\repo\\rules\\review.mdc", "d:/code/repo/rules/review.mdc")).toBe(true)
  })

  test("different files stay different", () => {
    expect(Filesystem.sameFilepath("d:/code/repo/a.mdc", "d:/code/repo/b.mdc")).toBe(false)
  })
})

describe("Filesystem.up", () => {
  test("stops at the start directory when stop differs only in spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "merakcode-fs-up-"))
    const child = join(root, "child")
    await mkdir(join(root, ".merakcode"))
    await mkdir(child)
    try {
      const found = await Array.fromAsync(
        Filesystem.up({
          targets: [".merakcode"],
          start: `${child}/`,
          stop: child,
        }),
      )
      expect(found.some((dir) => Filesystem.sameDirectory(dir, join(root, ".merakcode")))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("Filesystem read and write", () => {
  let root = ""
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "merakcode-fs-io-"))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("exists is true for files and directories, isDir only for directories, isFile only for files", async () => {
    const dir = join(root, "kinds", "dir")
    const file = join(root, "kinds", "file.txt")
    const missing = join(root, "kinds", "missing")
    await mkdir(dir, { recursive: true })
    await writeFile(file, "hello")
    expect(await Promise.all([dir, file, missing].map(Filesystem.exists))).toEqual([true, true, false])
    expect(await Promise.all([dir, file, missing].map(Filesystem.isDir))).toEqual([true, false, false])
    expect(await Promise.all([dir, file, missing].map(Filesystem.isFile))).toEqual([false, true, false])
  })

  test("write creates parent directories and accepts strings, bytes, Blob and Response", async () => {
    const target = (name: string) => join(root, "write", "nested", name)
    await Filesystem.write(target("a.txt"), "text")
    await Filesystem.write(target("b.bin"), new Uint8Array([1, 2, 3]))
    await Filesystem.write(target("c.txt"), new Blob(["blob"]))
    await Filesystem.write(target("d.txt"), new Response("response"))
    expect(await readFile(target("a.txt"), "utf8")).toBe("text")
    expect([...(await readFile(target("b.bin")))]).toEqual([1, 2, 3])
    expect(await readFile(target("c.txt"), "utf8")).toBe("blob")
    expect(await readFile(target("d.txt"), "utf8")).toBe("response")
  })

  test("readText / readJson / readBytes return what was written and reject for missing files", async () => {
    const file = join(root, "read", "data.json")
    await Filesystem.write(file, JSON.stringify({ a: 1 }))
    expect(await Filesystem.readText(file)).toBe('{"a":1}')
    expect(await Filesystem.readJson(file)).toEqual({ a: 1 })
    expect(new TextDecoder().decode(await Filesystem.readBytes(file))).toBe('{"a":1}')
    await expect(Filesystem.readText(join(root, "read", "missing"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  // Matches Bun.file().text(): JSON configs saved by Windows Notepad often start with a BOM
  test("readText / readJson strip a leading UTF-8 BOM", async () => {
    const file = join(root, "read", "bom.json")
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]))
    expect(await Filesystem.readText(file)).toBe('{"a":1}')
    expect(await Filesystem.readJson(file)).toEqual({ a: 1 })
  })

  test("copy copies the file and creates the target's parent directories", async () => {
    const source = join(root, "copy", "src.txt")
    const target = join(root, "copy", "deep", "dst.txt")
    await Filesystem.write(source, "copied")
    await Filesystem.copy(source, target)
    expect(await readFile(target, "utf8")).toBe("copied")
  })

  test("size returns the byte count, or 0 for missing files", async () => {
    const file = join(root, "size", "f.txt")
    await Filesystem.write(file, "12345")
    expect(await Filesystem.size(file)).toBe(5)
    expect(await Filesystem.size(join(root, "size", "missing"))).toBe(0)
  })
})

describe("Filesystem.mimeType", () => {
  test("infers from the extension; scripts are text/javascript (mime-types treats .ts as video)", () => {
    expect(Filesystem.mimeType("a.png")).toBe("image/png")
    expect(Filesystem.mimeType("a.svg")).toBe("image/svg+xml")
    expect(Filesystem.mimeType("a.pdf")).toBe("application/pdf")
    for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      expect(Filesystem.mimeType(`dir/a.${ext}`)).toBe("text/javascript;charset=utf-8")
    }
    expect(Filesystem.mimeType("a.json")).toBe("application/json;charset=utf-8")
  })

  test("unknown or missing extensions give application/octet-stream", () => {
    expect(Filesystem.mimeType("a.unknownext")).toBe("application/octet-stream")
    expect(Filesystem.mimeType("Makefile")).toBe("application/octet-stream")
  })
})

describe("Filesystem.readRange", () => {
  test("reads the bytes in [start, end) and truncates past the end", async () => {
    const root = await mkdtemp(join(tmpdir(), "merakcode-fs-range-"))
    try {
      const file = join(root, "f.txt")
      await writeFile(file, "0123456789")
      expect(new TextDecoder().decode(await Filesystem.readRange(file, 2, 5))).toBe("234")
      expect(new TextDecoder().decode(await Filesystem.readRange(file, 8, 100))).toBe("89")
      expect((await Filesystem.readRange(file, 20, 30)).length).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
