import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { MemoryScan } from "@merakcode/engine/agent/memory/scan"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * MemoryScan caches by the mtimes of the four memory type directories, so steady-state recall costs a few stats
 * instead of reading every file header. Any directory mtime change triggers a rescan.
 */
function frontmatter(name: string, description: string, type: string) {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\nbody\n`
}

async function writeMemory(root: string, type: string, filename: string, content: string) {
  const filepath = path.join(root, type, filename)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Filesystem.write(filepath, content)
  return filepath
}

describe("MemoryScan mtime signature cache", () => {
  test("returns the same cached array when nothing changed", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(root, "user", "a.md", frontmatter("A", "desc a", "user"))

    const first = await MemoryScan.files(root)
    const second = await MemoryScan.files(root)
    expect(second).toBe(first)
  })

  test("rescans after invalidate, returning a new array with the same content", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(root, "user", "a.md", frontmatter("A", "desc a", "user"))

    const first = await MemoryScan.files(root)
    MemoryScan.invalidate(root)
    const second = await MemoryScan.files(root)

    expect(second).not.toBe(first)
    expect(second.map((f) => f.filename)).toEqual(first.map((f) => f.filename))
  })

  test("rescans and sees new files when a type directory mtime changes", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(root, "user", "a.md", frontmatter("A", "desc a", "user"))

    const first = await MemoryScan.files(root)
    expect(first).toHaveLength(1)

    // Bump the mtime explicitly with utimes because mtime precision differs across platforms.
    await writeMemory(root, "user", "b.md", frontmatter("B", "desc b", "user"))
    const userDir = path.join(root, "user")
    const future = new Date(Date.now() + 5000)
    await fs.utimes(userDir, future, future)

    const second = await MemoryScan.files(root)
    expect(second).not.toBe(first)
    expect(second).toHaveLength(2)
    expect(second.map((f) => f.filename.replaceAll(path.sep, "/")).sort()).toEqual(["user/a.md", "user/b.md"])
  })

  test("keeps a separate cache per memoryDir", async () => {
    await using tmp = await tmpdir()
    const rootA = path.join(tmp.path, "memoryA")
    const rootB = path.join(tmp.path, "memoryB")
    await writeMemory(rootA, "user", "a.md", frontmatter("A", "desc a", "user"))
    await writeMemory(rootB, "user", "b.md", frontmatter("B", "desc b", "user"))

    const filesA = await MemoryScan.files(rootA)
    const filesB = await MemoryScan.files(rootB)

    expect(filesA.map((f) => f.filename.replaceAll(path.sep, "/"))).toEqual(["user/a.md"])
    expect(filesB.map((f) => f.filename.replaceAll(path.sep, "/"))).toEqual(["user/b.md"])
  })
})
