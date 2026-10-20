import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { removing, tmpdir } from "./fixture"

test("tmpdir is removed with its contents after leaving scope, in the background before the file ends", async () => {
  let dir = ""
  {
    await using tmp = await tmpdir({ git: true, config: { model: "test/model" } })
    dir = tmp.path
    await Filesystem.write(path.join(dir, "nested", "a.txt"), "x")
  }
  await removing()
  expect(await Filesystem.exists(dir)).toBe(false)
})
