import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Vcs } from "@merakcode/engine/app/project/vcs"
import { tmpdir } from "../fixture/fixture"

// Desktop commit: commits changes with an AI-generated or user-written message. all=true first stages every change,
// including new files.

const log = (cwd: string) =>
  Process.run(["git", "log", "-n", "1", "--format=%s%n%b"], { cwd }).then((r) => r.text().trim())
const status = (cwd: string) => Process.run(["git", "status", "--porcelain"], { cwd }).then((r) => r.text().trim())

test("commit all includes new and modified files, leaves a clean tree and returns the hash", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(path.join(tmp.path, "a.txt"), "hello\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await Vcs.commit({ message: "feat: add a.txt\n\nbody line", all: true })
      expect(result.ok).toBe(true)
      expect(result.ok && result.hash).toMatch(/^[0-9a-f]{7,40}$/)
      expect(await log(tmp.path)).toBe("feat: add a.txt\nbody line")
      expect(await status(tmp.path)).toBe("")
    },
  })
})

test("commits only staged changes and leaves unstaged ones in the worktree", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(path.join(tmp.path, "staged.txt"), "1\n")
  await Filesystem.write(path.join(tmp.path, "loose.txt"), "2\n")
  await Process.run(["git", "add", "staged.txt"], { cwd: tmp.path })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await Vcs.commit({ message: "only staged" })).ok).toBe(true)
      expect(await status(tmp.path)).toBe("?? loose.txt")
    },
  })
})

test("does not commit and explains why when there are no changes or the message is empty", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Vcs.commit({ message: "nothing", all: true })).toEqual({ ok: false, error: "nothing to commit" })
      await Filesystem.write(path.join(tmp.path, "a.txt"), "x\n")
      expect(await Vcs.commit({ message: "   ", all: true })).toEqual({ ok: false, error: "empty commit message" })
      expect(await status(tmp.path)).toBe("?? a.txt")
    },
  })
})
