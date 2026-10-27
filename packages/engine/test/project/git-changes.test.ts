import path from "node:path"
import { expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/project/instance"
import { GitChanges } from "@merakcode/engine/project/git-changes"
import { tmpdir } from "../fixture/fixture"

const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((result) => result.text())

test("lists staged and unstaged snapshots independently for the same file", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, "original\n")
  await git(tmp.path, "add", "a.txt")
  await git(tmp.path, "commit", "-m", "original")
  await Filesystem.write(file, "staged\n")
  await git(tmp.path, "add", "a.txt")
  await Filesystem.write(file, "working\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await GitChanges.get()
      expect(result.staged.map((item) => [item.file, item.status])).toEqual([["a.txt", "modified"]])
      expect(result.unstaged.map((item) => [item.file, item.status])).toEqual([["a.txt", "modified"]])
      expect(await git(tmp.path, "show", ":a.txt")).toBe("staged\n")
      expect(await Filesystem.readText(file)).toBe("working\n")
    },
  })
})

test("staging selected files preserves working contents and leaves other files unstaged", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(path.join(tmp.path, "a.txt"), "a\n")
  await Filesystem.write(path.join(tmp.path, "b.txt"), "b\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await GitChanges.get()
      const result = await GitChanges.stage({
        expectedCheckout: before.checkout,
        files: [before.unstaged.find((file) => file.file === "a.txt")!],
      })
      expect(result.staged.map((file) => file.file)).toEqual(["a.txt"])
      expect(result.unstaged.map((file) => file.file)).toEqual(["b.txt"])
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe("a\n")
    },
  })
})

test("unstaging a new file preserves its working contents", async () => {
  await using tmp = await tmpdir({ git: true })
  await Filesystem.write(path.join(tmp.path, "new file.txt"), "keep this\n")
  await git(tmp.path, "add", ".")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await GitChanges.get()
      const result = await GitChanges.unstage({ expectedCheckout: before.checkout, files: before.staged })
      expect(result.staged).toEqual([])
      expect(result.unstaged.map((file) => file.file)).toEqual(["new file.txt"])
      expect(await Filesystem.readText(path.join(tmp.path, "new file.txt"))).toBe("keep this\n")
    },
  })
})

test("unstaging also works before the first commit", async () => {
  await using tmp = await tmpdir()
  await git(tmp.path, "init")
  await Filesystem.write(path.join(tmp.path, "new.txt"), "new\n")
  await git(tmp.path, "add", ".")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await GitChanges.get()
      const after = await GitChanges.unstage({ expectedCheckout: before.checkout, files: before.staged })
      expect(after.staged).toEqual([])
      expect(after.unstaged.map((file) => file.file)).toEqual(["new.txt"])
    },
  })
})

test("a displayed deletion cannot stage a replacement whose contents equal a missing-file marker", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, "original\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "original")
  const { unlink } = await import("node:fs/promises")
  await unlink(file)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const deletion = await GitChanges.get()
      await Filesystem.write(file, "missing")
      await expect(
        GitChanges.stage({ expectedCheckout: deletion.checkout, files: deletion.unstaged }),
      ).rejects.toMatchObject({ name: "GitChangesStaleError" })
      expect(await git(tmp.path, "show", ":a.txt")).toBe("original\n")
    },
  })
})

test("an unborn repository can list an embedded repository directory", async () => {
  await using tmp = await tmpdir()
  await git(tmp.path, "init")
  const nested = path.join(tmp.path, "nested")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(nested)
  await git(nested, "init")
  await git(
    nested,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "nested",
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await GitChanges.get()
      expect(result.unstaged.map((file) => [file.file, file.status])).toEqual([["nested/", "added"]])
    },
  })
})

test("resolved merge-conflict files can be staged using the ordinary Git operation", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, "base\n")
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "base")
  const main = (await git(tmp.path, "branch", "--show-current")).trim()
  await git(tmp.path, "branch", "other")
  await Filesystem.write(file, "main\n")
  await git(tmp.path, "commit", "-am", "main")
  await git(tmp.path, "switch", "other")
  await Filesystem.write(file, "other\n")
  await git(tmp.path, "commit", "-am", "other")
  expect((await Process.run(["git", "merge", main], { cwd: tmp.path, nothrow: true })).exitCode).toBe(1)
  await Filesystem.write(file, "resolved\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await GitChanges.get()
      expect(before.unstaged[0]?.status).toBe("conflicted")
      const after = await GitChanges.stage({ expectedCheckout: before.checkout, files: before.unstaged })
      expect(after.unstaged).toEqual([])
      expect(after.staged.map((file) => file.status)).toEqual(["modified"])
      expect(await git(tmp.path, "show", ":a.txt")).toBe("resolved\n")
    },
  })
})
