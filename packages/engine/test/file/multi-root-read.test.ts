import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { File } from "@merakcode/engine/file/index"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

/**
 * In multi-root the desktop file tree passes absolute paths, while the index and tool display layer pass
 * `folderName/rel`. File.read must handle both.
 */
describe("File.read multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  const provide = async <T>(fn: (a: string, b: string) => Promise<T>) => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "only-b.txt"), "hello from beta")
      },
    })
    return await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: () => fn(a.path, b.path),
    })
  }

  test("reads a second-root file by absolute path (as sent by the file tree)", async () => {
    await provide(async (_a, b) => {
      const content = await File.read(path.join(b, "only-b.txt"))
      expect(content.content).toContain("hello from beta")
    })
  })

  test("reads a second-root file by folderName/rel (as used by the index and display layer)", async () => {
    await provide(async () => {
      const content = await File.read("beta/only-b.txt")
      expect(content.content).toContain("hello from beta")
    })
  })

  test("returns a diff for a modified tracked file in the second root (git runs in that root)", async () => {
    await provide(async (_a, b) => {
      const file = path.join(b, "only-b.txt")
      await Process.run(["git", "add", "-A"], { cwd: b, nothrow: true })
      await Process.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"], {
        cwd: b,
        nothrow: true,
      })
      await Filesystem.write(file, "hello from beta changed")

      const content = await File.read(file)
      expect(content.content).toContain("changed")
      expect(content.diff ?? "").toContain("changed")
    })
  })

  test("reads an absolute path outside the workspace without Access denied", async () => {
    await provide(async () => {
      await using outside = await tmpdir({
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "outside.txt"), "outside content")
        },
      })
      const content = await File.read(path.join(outside.path, "outside.txt"))
      expect(content.content).toBe("outside content")
    })
  })

  test("single-root relative paths behave as before", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "root.txt"), "single root")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const content = await File.read("root.txt")
        expect(content.content).toContain("single root")
      },
    })
  })
})
