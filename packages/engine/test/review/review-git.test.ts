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

const decide = async (input: Omit<Review.Decision, "expectedCheckout">) =>
  Review.decide({ ...input, expectedCheckout: (await Review.get(input)).checkout })
const undo = async (input: Review.Input) =>
  Review.undo({ ...input, expectedCheckout: (await Review.get(input)).checkout })
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")
const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((r) => r.text())
const hunksOf = async (input: Review.Input, file: string) => (await Review.file({ ...input, file })).hunks

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
      expect(review.files.map((file) => [file.file, file.status, file.hunks])).toEqual([["a.txt", "modified", 2]])
      const [first, second] = await hunksOf({ scope: "unstaged" }, "a.txt")

      const after = await decide({
        scope: "unstaged",
        decision: "accept",
        files: [{ file: "a.txt", hunks: [first!.id] }],
      })
      expect(await git(tmp.path, "show", ":a.txt")).toBe(lines(30).replace("line 2\n", "two\n"))
      expect(after.files[0]!.hunks).toBe(1)
      expect((await hunksOf({ scope: "unstaged" }, "a.txt")).map((hunk) => hunk.id)).toEqual([second!.id])

      await decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(lines(30).replace("line 2\n", "two\n"))
      expect((await Review.get({ scope: "unstaged" })).files).toEqual([])
    },
  })
})

test("the list has counts and a version per file; details answer for the listed version and are stale after a change", async () => {
  await using tmp = await repo()
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, lines(30).replace("line 2\n", "two\n"))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const input = { scope: "unstaged" as const }
      const [listed] = (await Review.get(input)).files
      expect(listed).toMatchObject({ file: "a.txt", additions: 1, deletions: 1, hunks: 1, accepted: 0 })
      const detail = await Review.file({ ...input, file: "a.txt", version: listed!.version })
      expect(detail).toMatchObject({ file: "a.txt", version: listed!.version, before: lines(30) })
      expect(detail.after).toBe(lines(30).replace("line 2\n", "two\n"))
      expect(detail.hunks[0]!.lines.filter((line) => line.kind !== "context").map((line) => line.text)).toEqual([
        "line 2",
        "two",
      ])

      await Filesystem.write(file, lines(30).replace("line 3\n", "three\n"))
      const [next] = (await Review.get(input)).files
      expect(next!.version).not.toBe(listed!.version)
      await expect(Review.file({ ...input, file: "a.txt", version: listed!.version })).rejects.toMatchObject({
        name: "ReviewStaleError",
      })

      // Until the list is fetched again, details match the list the client is showing
      await Filesystem.write(file, "changed again\n")
      const shown = await Review.file({ ...input, file: "a.txt", version: next!.version })
      expect(shown.after).toBe(lines(30).replace("line 3\n", "three\n"))
    },
  })
})

test("the version depends only on content: restoring earlier content gives the same version and hunks", async () => {
  await using tmp = await repo()
  const file = path.join(tmp.path, "a.txt")
  const first = lines(30).replace("line 2\n", "two\n")
  await Filesystem.write(file, first)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const input = { scope: "unstaged" as const }
      const before = (await Review.get(input)).files[0]!
      const ids = (await hunksOf(input, "a.txt")).map((hunk) => hunk.id)
      await Filesystem.write(file, lines(30).replace("line 9\n", "nine\n"))
      expect((await Review.get(input)).files[0]!.version).not.toBe(before.version)
      await Filesystem.write(file, first)
      expect((await Review.get(input)).files[0]!.version).toBe(before.version)
      expect((await hunksOf(input, "a.txt")).map((hunk) => hunk.id)).toEqual(ids)
    },
  })
})

test("large files have hunks but no full text", async () => {
  await using tmp = await tmpdir({ git: true })
  const big = Array.from({ length: 6000 }, (_, i) => `${"x".repeat(80)} ${i}\n`).join("")
  await Filesystem.write(path.join(tmp.path, "big.txt"), big)
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "big")
  await Filesystem.write(path.join(tmp.path, "big.txt"), big.replace(`${"x".repeat(80)} 10\n`, "ten\n"))
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const detail = await Review.file({ scope: "unstaged", file: "big.txt" })
      expect(detail.before).toBeUndefined()
      expect(detail.after).toBeUndefined()
      expect(detail.hunks[0]!.lines.some((line) => line.kind === "add" && line.text === "ten")).toBe(true)
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
      await decide({ scope: "unstaged", decision: "accept", files: [{ file: "new.txt" }] })
      await decide({ scope: "unstaged", decision: "reject", files: [{ file: "drop.txt" }] })
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
      const [first] = await hunksOf({ scope: "staged" }, "a.txt")
      await decide({ scope: "staged", decision: "reject", files: [{ file: "a.txt", hunks: [first!.id] }] })
      expect(await git(tmp.path, "show", ":a.txt")).toBe(lines(30).replace("line 20\n", "twenty\n"))
      expect(await Filesystem.readText(path.join(tmp.path, "a.txt"))).toBe(changed)
      await expect(decide({ scope: "staged", decision: "accept" })).rejects.toMatchObject({
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
      const decision = decide({
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
      const [first, second] = await hunksOf({ scope: "branch", base: main }, "a.txt")
      expect([first, second].map((hunk) => hunk!.lines.find((line) => line.kind === "add")?.text)).toEqual([
        "two",
        "twenty",
      ])

      await decide({
        scope: "branch",
        base: main,
        decision: "accept",
        files: [{ file: "a.txt", hunks: [first!.id] }],
      })
      const again = await Review.get({ scope: "branch", base: main })
      expect(again.files[0]!.accepted).toBe(1)
      expect((await hunksOf({ scope: "branch", base: main }, "a.txt")).map((hunk) => hunk.state)).toEqual([
        "accepted",
        undefined,
      ])

      await decide({
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
      await Review.get({ scope: "unstaged" })
      const [first, second] = await hunksOf({ scope: "unstaged" }, "a.txt")
      expect(first!.lines.filter((line) => line.kind !== "context").map((line) => line.text)).toEqual(["line 2", "two"])
      await decide({ scope: "unstaged", decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      expect(await git(tmp.path, "cat-file", "blob", ":a.txt")).toBe(lines(30).replace("line 2\n", "two\n"))
      await decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
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
      expect(file).toMatchObject({ file: "logo.bin", binary: true, status: "modified", hunks: 1 })
      const detail = await Review.file({ scope: "unstaged", file: "logo.bin", version: file!.version })
      expect(detail.hunks.map((hunk) => hunk.lines)).toEqual([[]])
      expect(detail.before).toBeUndefined()
      await decide({ scope: "unstaged", decision: "reject", files: [{ file: "logo.bin" }] })
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
      const [first, second] = await hunksOf({ scope: "unstaged" }, "a.txt")
      await decide({ scope: "unstaged", decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      await decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })

      await undo({ scope: "unstaged" })
      expect(await Filesystem.readText(file)).toBe(changed)
      await undo({ scope: "unstaged" })
      expect(await git(tmp.path, "show", ":a.txt")).toBe(lines(30))
      expect((await hunksOf({ scope: "unstaged" }, "a.txt")).map((hunk) => hunk.id)).toEqual([first!.id, second!.id])
      await expect(undo({ scope: "unstaged" })).rejects.toMatchObject({ name: "ReviewStaleError" })

      await decide({ scope: "unstaged", decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      await Filesystem.write(file, "edited again\n")
      await expect(undo({ scope: "unstaged" })).rejects.toMatchObject({ name: "ReviewStaleError" })
      expect(await Filesystem.readText(file)).toBe("edited again\n")
    },
  })
})
