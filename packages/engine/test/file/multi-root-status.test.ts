import { afterEach, describe, expect, test } from "vitest"
import path from "path"
import { File } from "@merakcode/engine/agent/workspace/file/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * In multi-root each folder is its own git repo, like VS Code source control grouping by repository. File.status must
 * aggregate all roots and use `folderName/rel` paths, matching the index and displayPath.
 */
describe("File.status multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("aggregates changes from both roots with folder name prefixes", async () => {
    await using a = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a-new.txt"), "alpha change")
      },
    })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "b-new.txt"), "beta change")
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
        const status = await File.status()
        const paths = status.map((x) => x.path.replace(/\\/g, "/"))
        expect(paths).toContain("alpha/a-new.txt")
        expect(paths).toContain("beta/b-new.txt")
      },
    })
  })

  test("returns second-root changes when the primary is not a git repo", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "only-b.txt"), "beta only")
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
        const paths = (await File.status()).map((x) => x.path.replace(/\\/g, "/"))
        expect(paths).toContain("beta/only-b.txt")
      },
    })
  })

  test("single-root paths have no prefix", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "solo.txt"), "solo")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = (await File.status()).map((x) => x.path.replace(/\\/g, "/"))
        expect(paths).toContain("solo.txt")
      },
    })
  })
})
