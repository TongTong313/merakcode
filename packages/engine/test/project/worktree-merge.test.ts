import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/project/instance"
import { Worktree } from "@merakcode/engine/worktree/index"
import { GlobalBus } from "@merakcode/engine/bus/global"
import { tmpdir } from "../fixture/fixture"

// Worktree sessions: open a worktree from a given branch, let the agent edit there, then merge back into the main
// worktree's current branch. Uncommitted changes are committed to the worktree branch first; on conflict the merge is
// aborted, the conflicting files are listed and the main worktree is left untouched.

const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((r) => r.text().trim())

/** Waits for the worktree checkout; creation is async and emits worktree.ready when done */
function ready(directory: string) {
  return new Promise<void>((resolve, reject) => {
    const listener = (event: { directory?: string; payload: { type: string; properties: { message?: string } } }) => {
      if (event.directory !== directory) return
      if (event.payload.type === "worktree.failed") reject(new Error(event.payload.properties.message))
      if (event.payload.type !== "worktree.ready") return
      GlobalBus.off("event", listener)
      resolve()
    }
    GlobalBus.on("event", listener)
  })
}

async function repo() {
  const tmp = await tmpdir({ git: true })
  // A global autocrlf would check files out as CRLF; these tests only care about merging
  await git(tmp.path, "config", "core.autocrlf", "false")
  await Filesystem.write(path.join(tmp.path, "a.txt"), "a\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "init")
  return tmp
}

async function open(base?: string) {
  const info = await Worktree.create({ ...(base ? { base } : {}) })
  await ready(info.directory)
  return info
}

test("opens a worktree from a branch, commits pending changes and merges back with a merge commit", async () => {
  await using tmp = await repo()
  const main = await git(tmp.path, "rev-parse", "--abbrev-ref", "HEAD")
  await git(tmp.path, "checkout", "-b", "dev")
  await Filesystem.write(path.join(tmp.path, "dev.txt"), "dev\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "dev")
  await git(tmp.path, "checkout", main)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const info = await open("dev")
      expect(await Filesystem.readText(path.join(info.directory, "dev.txt"))).toBe("dev\n")
      await Filesystem.write(path.join(info.directory, "feature.txt"), "feature\n")

      const result = await Worktree.merge({ directory: info.directory, message: "add feature" })
      expect(result).toMatchObject({ ok: true })
      expect(await Filesystem.readText(path.join(tmp.path, "feature.txt"))).toBe("feature\n")
      expect(await git(tmp.path, "log", "-1", "--format=%P")).toMatch(/^\S+ \S+$/)
      expect(await git(tmp.path, "status", "--porcelain")).toBe("")
      await Worktree.remove({ directory: info.directory })
    },
  })
}, 60_000)

test("squash merge adds a single commit with the given message to the main worktree", async () => {
  await using tmp = await repo()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const info = await open()
      await Filesystem.write(path.join(info.directory, "one.txt"), "1\n")
      await git(info.directory, "add", ".")
      await git(info.directory, "commit", "-m", "one")
      await Filesystem.write(path.join(info.directory, "two.txt"), "2\n")

      expect(
        await Worktree.merge({ directory: info.directory, squash: true, message: "feature in one" }),
      ).toMatchObject({ ok: true })
      expect(await git(tmp.path, "log", "-1", "--format=%s|%P")).toMatch(/^feature in one\|\S+$/)
      expect(await git(tmp.path, "ls-files")).toBe("a.txt\none.txt\ntwo.txt")
      await Worktree.remove({ directory: info.directory })
    },
  })
}, 60_000)

test("on conflict, aborts the merge, lists conflicting files and restores the main worktree", async () => {
  await using tmp = await repo()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const info = await open()
      await Filesystem.write(path.join(info.directory, "a.txt"), "from worktree\n")
      await Filesystem.write(path.join(tmp.path, "a.txt"), "from main\n")
      await git(tmp.path, "commit", "-am", "main change")
      const head = await git(tmp.path, "rev-parse", "HEAD")

      expect(await Worktree.merge({ directory: info.directory })).toEqual({
        ok: false,
        reason: "conflict",
        files: ["a.txt"],
      })
      expect(await git(tmp.path, "rev-parse", "HEAD")).toBe(head)
      expect(await git(tmp.path, "status", "--porcelain")).toBe("")
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe("from main\n")
      await Worktree.remove({ directory: info.directory })
    },
  })
}, 60_000)
