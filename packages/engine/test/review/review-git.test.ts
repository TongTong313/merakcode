import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/project/instance"
import { Review } from "@merakcode/engine/review/index"
import { tmpdir } from "../fixture/fixture"

// Reviewing git changes: accepting an unstaged hunk stages it and rejecting discards it; staged hunks can only be
// unstaged. The branch scope diffs against the merge base, where accepting only marks a hunk and rejecting writes
// back to the worktree.

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")
const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((r) => r.text())

async function repo() {
  const tmp = await tmpdir({ git: true })
  await Filesystem.write(path.join(tmp.path, "a.txt"), lines(30))
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "init")
  return tmp
}

test("unstaged: accepting a hunk stages only that hunk and rejecting discards only that hunk", async () => {
  await using tmp = await repo()
  const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")
  await Filesystem.write(path.join(tmp.path, "a.txt"), changed)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const review = await Review.get({ scope: "unstaged" })
      expect(review.actions).toEqual({ accept: true, reject: true })
      expect(review.files.map((file) => [file.file, file.status, file.hunks.length])).toEqual([
        ["a.txt", "modified", 2],
      ])
      const [first, second] = review.files[0]!.hunks

      const after = await Review.decide({
        scope: "unstaged",
        decision: "accept",
        files: [{ file: "a.txt", hunks: [first!.id] }],
      })
      expect(await git(tmp.path, "show", ":a.txt")).toBe(lines(30).replace("line 2\n", "two\n"))
      expect(after.files[0]!.hunks.map((hunk) => hunk.id)).toEqual([second!.id])

      await Review.decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(lines(30).replace("line 2\n", "two\n"))
      expect((await Review.get({ scope: "unstaged" })).files).toEqual([])
    },
  })
})

test("untracked files: accepting adds them to the index and rejecting deletes them", async () => {
  await using tmp = await repo()
  await Filesystem.write(path.join(tmp.path, "new.txt"), "hello\n")
  await Filesystem.write(path.join(tmp.path, "drop.txt"), "bye\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const review = await Review.get({ scope: "unstaged" })
      expect(review.files.map((file) => [file.file, file.status])).toEqual([
        ["drop.txt", "added"],
        ["new.txt", "added"],
      ])
      await Review.decide({ scope: "unstaged", decision: "accept", files: [{ file: "new.txt" }] })
      await Review.decide({ scope: "unstaged", decision: "reject", files: [{ file: "drop.txt" }] })
      expect(await git(tmp.path, "show", ":new.txt")).toBe("hello\n")
      expect(await Filesystem.exists(path.join(tmp.path, "drop.txt"))).toBe(false)
      expect((await Review.get({ scope: "unstaged" })).files).toEqual([])
    },
  })
})

test("staged: hunks can only be unstaged, one at a time, leaving the worktree untouched", async () => {
  await using tmp = await repo()
  const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")
  await Filesystem.write(path.join(tmp.path, "a.txt"), changed)
  await git(tmp.path, "add", "a.txt")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const review = await Review.get({ scope: "staged" })
      expect(review.actions).toEqual({ accept: false, reject: true })
      const [first] = review.files[0]!.hunks
      await Review.decide({ scope: "staged", decision: "reject", files: [{ file: "a.txt", hunks: [first!.id] }] })
      expect(await git(tmp.path, "show", ":a.txt")).toBe(lines(30).replace("line 20\n", "twenty\n"))
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(changed)
      await expect(Review.decide({ scope: "staged", decision: "accept" })).rejects.toMatchObject({
        name: "ReviewInvalidError",
      })
    },
  })
})

test("reports stale and changes no files when a hunk no longer exists", async () => {
  await using tmp = await repo()
  await Filesystem.write(path.join(tmp.path, "a.txt"), lines(30).replace("line 2\n", "two\n"))
  await Filesystem.write(path.join(tmp.path, "b.txt"), "b\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const decision = Review.decide({
        scope: "unstaged",
        decision: "reject",
        files: [{ file: "b.txt" }, { file: "a.txt", hunks: ["0000000000000000"] }],
      })
      await expect(decision).rejects.toMatchObject({ name: "ReviewStaleError" })
      expect(await Filesystem.exists(path.join(tmp.path, "b.txt"))).toBe(true)
    },
  })
})

test("branch: diffs committed and uncommitted changes against the merge base; accept only records, reject writes back", async () => {
  await using tmp = await repo()
  const main = (await git(tmp.path, "rev-parse", "--abbrev-ref", "HEAD")).trim()
  await git(tmp.path, "checkout", "-b", "feature")
  await Filesystem.write(path.join(tmp.path, "a.txt"), lines(30).replace("line 2\n", "two\n"))
  await git(tmp.path, "commit", "-am", "two")
  await Filesystem.write(
    path.join(tmp.path, "a.txt"),
    lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n"),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const review = await Review.get({ scope: "branch", base: main })
      expect(review.base).toBe(main)
      const [first, second] = review.files[0]!.hunks
      expect([first, second].map((hunk) => hunk!.lines.find((line) => line.kind === "add")?.text)).toEqual([
        "two",
        "twenty",
      ])

      await Review.decide({
        scope: "branch",
        base: main,
        decision: "accept",
        files: [{ file: "a.txt", hunks: [first!.id] }],
      })
      const again = await Review.get({ scope: "branch", base: main })
      expect(again.files[0]!.hunks.map((hunk) => hunk.state)).toEqual(["accepted", undefined])
      expect(again.files[0]!.accepted).toBe(1)

      await Review.decide({
        scope: "branch",
        base: main,
        decision: "reject",
        files: [{ file: "a.txt", hunks: [second!.id] }],
      })
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(lines(30).replace("line 2\n", "two\n"))
      expect(await git(tmp.path, "status", "--porcelain")).toBe("")
    },
  })
})

test("with autocrlf and a CRLF worktree, only real changes are listed; the index stays LF and the worktree CRLF", async () => {
  await using tmp = await repo()
  await git(tmp.path, "config", "core.autocrlf", "true")
  const crlf = (text: string) => text.replaceAll("\n", "\r\n")
  const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")
  await Filesystem.write(path.join(tmp.path, "a.txt"), crlf(changed))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [first, second] = (await Review.get({ scope: "unstaged" })).files[0]!.hunks
      expect(first!.lines.filter((line) => line.kind !== "context").map((line) => line.text)).toEqual(["line 2", "two"])
      await Review.decide({ scope: "unstaged", decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      expect(await git(tmp.path, "cat-file", "blob", ":a.txt")).toBe(lines(30).replace("line 2\n", "two\n"))
      await Review.decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(crlf(lines(30).replace("line 2\n", "two\n")))
    },
  })
})

test("a binary file is a single hunk that is staged or restored as a whole", async () => {
  await using tmp = await repo()
  const image = path.join(tmp.path, "logo.bin")
  await Filesystem.write(image, new Uint8Array([0, 1, 2, 3]))
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "image")
  await Filesystem.write(image, new Uint8Array([0, 9, 9, 9]))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [file] = (await Review.get({ scope: "unstaged" })).files
      expect(file).toMatchObject({ file: "logo.bin", binary: true, status: "modified" })
      expect(file!.hunks).toHaveLength(1)
      await Review.decide({ scope: "unstaged", decision: "reject", files: [{ file: "logo.bin" }] })
      expect([...(await Filesystem.readBytes(image))]).toEqual([0, 1, 2, 3])
    },
  })
})

test("undo unstages accepted hunks and restores rejected ones, and reports stale once the file changed again", async () => {
  await using tmp = await repo()
  const file = path.join(tmp.path, "a.txt")
  const changed = lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")
  await Filesystem.write(file, changed)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [first, second] = (await Review.get({ scope: "unstaged" })).files[0]!.hunks
      await Review.decide({ scope: "unstaged", decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      await Review.decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })

      await Review.undo({ scope: "unstaged" })
      expect(await Filesystem.readText(file)).toBe(changed)
      await Review.undo({ scope: "unstaged" })
      expect(await git(tmp.path, "show", ":a.txt")).toBe(lines(30))
      expect((await Review.get({ scope: "unstaged" })).files[0]!.hunks.map((hunk) => hunk.id)).toEqual([
        first!.id,
        second!.id,
      ])
      await expect(Review.undo({ scope: "unstaged" })).rejects.toMatchObject({ name: "ReviewStaleError" })

      await Review.decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      await Filesystem.write(file, "edited again\n")
      await expect(Review.undo({ scope: "unstaged" })).rejects.toMatchObject({ name: "ReviewStaleError" })
      expect(await Filesystem.readText(file)).toBe("edited again\n")
    },
  })
})
