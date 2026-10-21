import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/project/instance"
import { Vcs } from "@merakcode/engine/project/vcs"
import { tmpdir } from "../fixture/fixture"

// Quick git commands run as git itself, in the worktree, and return the text git printed.

const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((r) => r.text().trim())

test("running git status prints the untracked file", async () => {
  await using tmp = await tmpdir({ git: true })
  await git(tmp.path, "config", "core.autocrlf", "false")
  await Filesystem.write(path.join(tmp.path, "c.txt"), "c\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Vcs.runGit(["status", "--porcelain"])
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain("c.txt")
    },
  })
})
