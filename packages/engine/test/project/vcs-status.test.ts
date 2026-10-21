import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/project/instance"
import { Vcs } from "@merakcode/engine/project/vcs"
import { tmpdir } from "../fixture/fixture"

// Branch overview: staged, unstaged and untracked file counts, plus commits ahead of and behind upstream.

const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((r) => r.text().trim())

test("status counts staged, unstaged and untracked files, and how far the branch is from upstream", async () => {
  await using tmp = await tmpdir({ git: true })
  await git(tmp.path, "config", "core.autocrlf", "false")
  await Filesystem.write(path.join(tmp.path, "a.txt"), "a\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "init")
  await using remote = await tmpdir()
  await git(remote.path, "init", "--bare", "--quiet")
  await git(tmp.path, "remote", "add", "origin", remote.path)
  const branch = await git(tmp.path, "rev-parse", "--abbrev-ref", "HEAD")
  await git(tmp.path, "push", "-u", "origin", "HEAD")
  await Filesystem.write(path.join(tmp.path, "ahead.txt"), "ahead\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "ahead")
  await git(tmp.path, "push")
  await git(tmp.path, "reset", "--hard", "HEAD~1")

  await Filesystem.write(path.join(tmp.path, "a.txt"), "changed\n")
  await Filesystem.write(path.join(tmp.path, "b.txt"), "b\n")
  await git(tmp.path, "add", "b.txt")
  await Filesystem.write(path.join(tmp.path, "c.txt"), "c\n")

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await Vcs.status()).toMatchObject({
        branch,
        remote: "origin",
        ahead: 0,
        behind: 1,
        staged: 1,
        unstaged: 1,
        untracked: 1,
      })
    },
  })
})
