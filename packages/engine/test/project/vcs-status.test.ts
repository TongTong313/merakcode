import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Vcs } from "@merakcode/engine/app/project/vcs"
import { tmpdir } from "../fixture/fixture"

// Branch overview: staged, unstaged and untracked file counts, plus commits ahead of and behind upstream.

const git = (cwd: string, ...args: string[]) =>
  Process.run(
    [
      "git",
      "-c",
      "user.name=MerakCode Test",
      "-c",
      "user.email=merakcode-test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  ).then((result) => result.text().trim())

test("status counts staged, unstaged and untracked files, and how far the branch is from upstream", async () => {
  await using tmp = await tmpdir()
  const branch = "status-fixture"
  await git(tmp.path, "init", "--initial-branch", branch)
  await git(tmp.path, "config", "core.autocrlf", "false")
  await Filesystem.write(path.join(tmp.path, "a.txt"), "a\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", `init ${tmp.path}`)
  await git(tmp.path, "remote", "add", "origin", tmp.path)
  await Filesystem.write(path.join(tmp.path, "ahead.txt"), "ahead\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "ahead")
  // Status reads local tracking refs; transport itself is covered by the push integration and desktop tests.
  await git(tmp.path, "update-ref", `refs/remotes/origin/${branch}`, "HEAD")
  await git(tmp.path, "branch", `--set-upstream-to=origin/${branch}`, branch)
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
