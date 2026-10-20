import { expect, test } from "vitest"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Snapshot } from "@merakcode/engine/snapshot/index"
import { Review } from "@merakcode/engine/review/index"
import { tmpdir } from "../fixture/fixture"

// Reviewing agent changes in a session: the baseline is the file content before the agent (or a subsession) first
// edited it. Accepting moves the baseline forward and rejecting reverts the hunk on disk. Files only the user changed
// are not listed.

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("")

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
      expect(review.files.map((file) => [file.file, file.status, file.hunks.length])).toEqual([
        ["a.txt", "modified", 2],
        ["src/b.txt", "added", 1],
      ])
      const [first, second] = review.files[0]!.hunks

      await Review.decide({ ...input, decision: "accept", files: [{ file: "a.txt", hunks: [first!.id] }] })
      expect((await Review.get(input)).files[0]!.hunks.map((hunk) => hunk.id)).toEqual([second!.id])
      expect(await Filesystem.readText(a)).toBe(lines(30).replace("line 2\n", "two\n").replace("line 20\n", "twenty\n"))

      await Review.decide({ ...input, decision: "reject", files: [{ file: "a.txt", hunks: [second!.id] }] })
      expect(await Filesystem.readText(a)).toBe(lines(30).replace("line 2\n", "two\n"))
      await Review.decide({ ...input, decision: "reject", files: [{ file: "src/b.txt" }] })
      expect(await Filesystem.exists(b)).toBe(false)
      expect((await Review.get(input)).files).toEqual([])

      // When the agent edits an accepted file again, only the new change is listed.
      await edit(session.id, a, lines(30).replace("line 2\n", "two\n").replace("line 29\n", "twenty-nine\n"))
      const next = await Review.get(input)
      expect(
        next.files[0]!.hunks.flatMap((hunk) =>
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
      await Review.decide({ ...input, decision: "accept" })
      expect((await Review.get(input)).files).toEqual([])
      // Turn and session scopes share one baseline and one undo history.
      const undone = await Review.undo(input)
      expect(undone.files.map((file) => file.file)).toEqual(["a.txt"])
    },
  })
})
