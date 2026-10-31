import { expect, test } from "vitest"
import path from "path"
import { File } from "@merakcode/engine/agent/workspace/file/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"
import { tmpdir } from "../fixture/fixture"

// Backs @ file mentions and quick open: fuzzy matching with a result count set by the caller
test("fuzzy file search honors the caller's limit instead of the default count", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Promise.all(
        Array.from({ length: 30 }, (_, i) => Filesystem.write(path.join(dir, "src", `widget-${i}.ts`), "")),
      )
      await Filesystem.write(path.join(dir, "README.md"), "")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await File.search({ query: "widget", limit: 200, type: "file" })).toHaveLength(30)

      const few = await File.search({ query: "widget", limit: 5, type: "file" })
      expect(few).toHaveLength(5)

      // Non-contiguous letters still match
      expect(await File.search({ query: "rdme", type: "file" })).toEqual(["README.md"])
    },
  })
})
