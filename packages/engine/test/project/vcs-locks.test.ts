import { expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Vcs } from "@merakcode/engine/app/project/vcs"
import { tmpdir } from "../fixture/fixture"

// The desktop app polls the git status in the background. A plain git status rewrites .git/index (under
// .git/index.lock) to cache file stats, so the user's own git add or commit fails with "index.lock: File exists" when
// the two meet. Reading the status must leave the index alone.
test("reading the git status leaves the index untouched", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, "a\n")
  await Process.run(["git", "add", "a.txt"], { cwd: tmp.path })
  await Process.run(["git", "commit", "--quiet", "-m", "a"], { cwd: tmp.path })
  // The file's stats no longer match the ones cached in the index, which a refreshing git status would rewrite
  const past = new Date(Date.now() - 3_600_000)
  await fs.utimes(file, past, past)
  const index = path.join(tmp.path, ".git", "index")
  const before = await fs.readFile(index)

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Vcs.status())?.unstaged).toBe(0)
    },
  })
  expect((await fs.readFile(index)).equals(before)).toBe(true)
})
