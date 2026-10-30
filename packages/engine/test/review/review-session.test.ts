import { expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Snapshot } from "@merakcode/engine/infra/project/snapshot/index"
import { Review } from "@merakcode/engine/agent/session/review/index"
import { tmpdir } from "../fixture/fixture"

// Reviewing agent changes in a session: the baseline is the file content before the agent (or a subsession) first
// edited it. Accepting moves the baseline forward and rejecting reverts the hunk on disk. Files only the user changed
// are not listed.

const decide = async (
  input: Omit<Review.Decision, "expectedCheckout" | "files"> & { files?: { file: string; hunks?: string[] }[] },
) => {
  const shown = await Review.get(input)
  const files = (input.files ?? shown.files).map((file) => ({
    file: file.file,
    hunks: Array.isArray(file.hunks) ? file.hunks : undefined,
    version: shown.files.find((item) => item.file === file.file)!.version,
  }))
  return Review.decide({ ...input, files, expectedCheckout: shown.checkout })
}
const undo = async (input: Review.Input) =>
  Review.undo({ ...input, expectedCheckout: (await Review.get(input)).checkout })
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")
const hunksOf = async (input: Review.Input, file: string) => (await Review.file({ ...input, file })).hunks

test("conversation review rejects Git scopes", () => {
  for (const scope of ["unstaged", "staged", "branch"]) expect(Review.Scope.safeParse(scope).success).toBe(false)
})

test("a whole-file decision refuses content changed after the displayed version", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, "before\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await edit(session.id, file, "agent\n")
      const input = { scope: "session" as const, sessionID: session.id }
      const displayed = await Review.get(input)
      await Filesystem.write(file, "later user edit\n")
      await expect(
        Review.decide({
          ...input,
          decision: "reject",
          expectedCheckout: displayed.checkout,
          files: displayed.files.map((file) => ({ file: file.file, version: file.version })),
        }),
      ).rejects.toMatchObject({ name: "ReviewStaleError" })
      expect(await Filesystem.readText(file)).toBe("later user edit\n")
    },
  })
})

/** Edits a file the way agent edit tools do, backing it up first. */
async function edit(sessionID: string, file: string, content: string) {
  await Snapshot.track(sessionID)
  await Snapshot.trackFile(file, sessionID)
  await Filesystem.write(file, content)
  await sleep(5)
}

async function ask(sessionID: string) {
  await sleep(5)
  const message = await Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  await sleep(5)
  return message.id
}

test("session: lists files changed by the agent and subsessions; accepted hunks drop out and rejected ones revert", async () => {
  await using tmp = await tmpdir({ git: true })
  const a = path.join(tmp.path, "a.txt")
  const b = path.join(tmp.path, "src", "b.txt")
  await Filesystem.write(a, lines(30))
  await Filesystem.write(path.join(tmp.path, "mine.txt"), "mine\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const child = await Session.create({ parentID: session.id })
      await edit(session.id, a, lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n"))
      await edit(child.id, b, "new\n")
      await Filesystem.write(path.join(tmp.path, "mine.txt"), "changed by me\n")

      const input = { scope: "session" as const, sessionID: session.id }
      const review = await Review.get(input)
      expect(review.files.map((file) => [file.file, file.status, file.hunks])).toEqual([
        ["a.txt", "modified", 2],
        ["src/b.txt", "added", 1],
      ])
      const [first, second] = await hunksOf(input, "a.txt")

      await decide({ ...input, decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      expect((await hunksOf(input, "a.txt")).map((hunk) => hunk.id)).toEqual([second!.id])
      expect(await Filesystem.readText(a)).toBe(lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n"))

      await decide({ ...input, decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      expect(await Filesystem.readText(a)).toBe(lines(30).replace("line 2\n", "two\n"))
      await decide({ ...input, decision: "reject", files: [{ file: "src/b.txt" }] })
      expect(await Filesystem.exists(b)).toBe(false)
      expect((await Review.get(input)).files).toEqual([])

      // When the agent edits an accepted file again, only the new change is listed.
      await edit(session.id, a, lines(30).replace("line 2\n", "two\n").replace("line 29\n", "twenty-nine\n"))
      expect(
        (await hunksOf(input, "a.txt")).flatMap((hunk) =>
          hunk.lines.filter((line) => line.kind === "add").map((line) => line.text),
        ),
      ).toEqual(["twenty-nine"])
    },
  })
})

test("turn: lists only files touched in that turn, including subsessions, with the same baseline as the session", async () => {
  await using tmp = await tmpdir({ git: true })
  const a = path.join(tmp.path, "a.txt")
  const b = path.join(tmp.path, "b.txt")
  await Filesystem.write(a, "a\n")
  await Filesystem.write(b, "b\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const first = await ask(session.id)
      await edit(session.id, a, "A\n")
      const second = await ask(session.id)
      const child = await Session.create({ parentID: session.id })
      await edit(child.id, b, "B\n")

      const files = async (messageID: string) =>
        (await Review.get({ scope: "turn", sessionID: session.id, messageID })).files.map((file) => file.file)
      expect(await files(first)).toEqual(["a.txt"])
      expect(await files(second)).toEqual(["b.txt"])
      await expect(Review.get({ scope: "turn", sessionID: session.id })).rejects.toMatchObject({
        name: "ReviewInvalidError",
      })
    },
  })
})

/** Windows 8.3 name of a path, or the path itself when there is no short name */
function windowsShort(file: string) {
  if (process.platform !== "win32") return file
  const listed = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (New-Object -ComObject Scripting.FileSystemObject).GetFile($env:MERAKCODE_TEST_SHORT_PATH).ShortPath",
    ],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, MERAKCODE_TEST_SHORT_PATH: file } },
  ).trim()
  return listed || file
}

test("session: a Windows short path to the same file is still listed relative to the project", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  await Filesystem.write(file, "a\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await edit(session.id, windowsShort(file), "A\n")
      const review = await Review.get({ scope: "session", sessionID: session.id })
      expect(review.files.map((item) => item.file)).toEqual(["a.txt"])
    },
  })
})

test("session: undoing an accept lists the hunk again", async () => {
  await using tmp = await tmpdir({ git: true })
  const a = path.join(tmp.path, "a.txt")
  await Filesystem.write(a, "a\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await edit(session.id, a, "A\n")
      const input = { scope: "session" as const, sessionID: session.id }
      await decide({ ...input, decision: "accept" })
      const accepted = await Review.get(input)
      expect(accepted.files).toEqual([])
      expect(accepted.last).toEqual({ decision: "accept", count: 1 })
      // Turn and session scopes share one baseline and one undo history.
      const undone = await undo(input)
      expect(undone.files.map((file) => file.file)).toEqual(["a.txt"])
      expect(undone.last).toBeUndefined()
    },
  })
})

test("large conversation files retain lazy hunk details without full text", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "big.txt")
  const big = Array.from({ length: 6000 }, (_, i) => `${"x".repeat(80)} ${i}\n`).join("")
  await Filesystem.write(file, big)
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await edit(session.id, file, big.replace(`${"x".repeat(80)} 10\n`, "ten\n"))
      const input = { scope: "session" as const, sessionID: session.id }
      const detail = await Review.file({ ...input, file: "big.txt" })
      expect(detail.before).toBeUndefined()
      expect(detail.after).toBeUndefined()
      expect(detail.hunks[0]!.lines.some((line) => line.kind === "add" && line.text === "ten")).toBe(true)
      await decide({ ...input, decision: "reject" })
      expect(await Filesystem.readText(file)).toBe(big)
    },
  })
})

test("conversation decisions preserve CRLF working files and leave the Git index LF", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "a.txt")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp.path, encoding: "utf8", windowsHide: true })
  await Filesystem.write(file, lines(30))
  git("add", ".")
  git("commit", "-m", "original")
  git("config", "core.autocrlf", "true")
  const crlf = (text: string) => text.replaceAll("\n", "\r\n")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = { scope: "session" as const, sessionID: session.id }
      await edit(session.id, file, crlf(lines(30)))
      expect((await Review.get(input)).files).toEqual([])
      await edit(session.id, file, crlf(lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n")))
      const [first, second] = await hunksOf(input, "a.txt")
      await decide({ ...input, decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      await decide({ ...input, decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      expect(await Filesystem.readText(file)).toBe(crlf(lines(30).replace("line 2\n", "two\n")))
      expect(git("show", ":a.txt")).toBe(lines(30))
    },
  })
})
