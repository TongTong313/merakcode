import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/project/instance"
import { Vcs } from "@merakcode/engine/project/vcs"
import { tmpdir } from "../fixture/fixture"

// Push goes to the upstream if set, otherwise to origin (or the only remote) and sets it as upstream; with no remote
// it explains why. The local branch list feeds the base branch picker in branch review; status includes the remote
// name and how many commits the branch is ahead of upstream.

const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((r) => r.text().trim())

async function repo() {
  const tmp = await tmpdir({ git: true })
  await git(tmp.path, "config", "core.autocrlf", "false")
  await Filesystem.write(path.join(tmp.path, "a.txt"), "a\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "init")
  return tmp
}

test("without upstream, pushes to origin and sets upstream; a new commit is ahead by 1 until pushed again", async () => {
  await using tmp = await repo()
  await using remote = await tmpdir()
  await git(remote.path, "init", "--bare", "--quiet")
  await git(tmp.path, "remote", "add", "origin", remote.path)
  const branch = await git(tmp.path, "rev-parse", "--abbrev-ref", "HEAD")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await Vcs.status()
      expect([before?.remote, before?.ahead]).toEqual(["origin", undefined])
      expect(await Vcs.push()).toEqual({ ok: true, branch, remote: "origin" })
      expect(await git(remote.path, "rev-parse", branch)).toBe(await git(tmp.path, "rev-parse", "HEAD"))

      await Filesystem.write(path.join(tmp.path, "b.txt"), "b\n")
      await git(tmp.path, "add", ".")
      await git(tmp.path, "commit", "-m", "b")
      expect(await Vcs.status()).toMatchObject({ remote: "origin", ahead: 1 })
      expect((await Vcs.push()).ok).toBe(true)
      expect(await Vcs.status()).toMatchObject({ ahead: 0 })
    },
  })
})

test("without a remote, does not push and explains why; local branches are listed by name", async () => {
  await using tmp = await repo()
  await git(tmp.path, "branch", "dev")
  await git(tmp.path, "branch", "feature/x")
  const main = await git(tmp.path, "rev-parse", "--abbrev-ref", "HEAD")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Vcs.push()).toEqual({ ok: false, error: "no remote" })
      expect((await Vcs.status())?.remote).toBeUndefined()
      expect(await Vcs.branches()).toEqual(["dev", "feature/x", main].toSorted())
    },
  })
})
