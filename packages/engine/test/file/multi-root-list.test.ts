import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { File } from "@merakcode/engine/file/index"
import { Instance } from "@merakcode/engine/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("File.list multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("empty path returns one top-level node per folder", async () => {
    await using a = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a.txt"), "a")
      },
    })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "b.txt"), "b")
      },
    })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const nodes = await File.list()
        expect(nodes).toHaveLength(2)
        expect(nodes.map((n) => n.name).sort()).toEqual(["alpha", "beta"])
        expect(nodes.every((n) => n.type === "directory")).toBe(true)
      },
    })
  })

  test("lists second-root contents by folder name or absolute path", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "only-b.txt"), "b")
      },
    })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const byName = await File.list("beta")
        expect(byName.some((n) => n.name === "only-b.txt")).toBe(true)

        const byAbs = await File.list(b.path)
        expect(byAbs.some((n) => n.name === "only-b.txt")).toBe(true)
        expect(
          byAbs.every((n) => path.isAbsolute(n.path) || Filesystem.sameDirectory(path.dirname(n.absolute), b.path)),
        ).toBe(true)
      },
    })
  })

  test("single-root list with a relative path behaves as before", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "root.txt"), "x")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nodes = await File.list()
        const file = nodes.find((n) => n.name === "root.txt")
        expect(file).toBeDefined()
        expect(file!.path).toBe("root.txt")
      },
    })
  })
})
