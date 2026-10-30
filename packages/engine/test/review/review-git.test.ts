import path from "node:path"
import { expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { GitChanges } from "@merakcode/engine/app/project/git-changes"
import { Review } from "@merakcode/engine/agent/session/review/index"
import { Session } from "@merakcode/engine/agent/session/index"
import { Snapshot } from "@merakcode/engine/infra/project/snapshot/index"
import { tmpdir } from "../fixture/fixture"

const git = (cwd: string, ...args: string[]) => Process.run(["git", ...args], { cwd }).then((result) => result.text())

test.each(["unstaged", "staged", "committed"] as const)(
  "review decisions preserve the Git index and history for %s edits",
  async (state) => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.txt")
    await Filesystem.write(file, "original\n")
    await git(tmp.path, "add", ".")
    await git(tmp.path, "commit", "-m", "original")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Snapshot.track(session.id)
        await Snapshot.trackFile(file, session.id)
        await Filesystem.write(file, "agent\n")
        if (state !== "unstaged") await git(tmp.path, "add", ".")
        if (state === "committed") await git(tmp.path, "commit", "-m", "without review")
        const index = state === "unstaged" ? "original\n" : "agent\n"
        const head = await git(tmp.path, "rev-parse", "HEAD")
        const input = { scope: "session" as const, sessionID: session.id }
        const before = await Review.get(input)
        const rejected = await Review.decide({
          ...input,
          decision: "reject",
          expectedCheckout: before.checkout,
          files: before.files.map((file) => ({ file: file.file, version: file.version })),
        })
        expect(rejected.files).toEqual([])
        expect(await Filesystem.readText(file)).toBe("original\n")
        expect(await git(tmp.path, "show", ":a.txt")).toBe(index)
        expect(await git(tmp.path, "rev-parse", "HEAD")).toBe(head)
        const changes = await GitChanges.get()
        expect(changes.staged.map((file) => file.file)).toEqual(state === "staged" ? ["a.txt"] : [])
        expect(changes.unstaged.map((file) => file.file)).toEqual(state === "unstaged" ? [] : ["a.txt"])
        await Review.undo({ ...input, expectedCheckout: rejected.checkout })
        expect(await Filesystem.readText(file)).toBe("agent\n")
        expect(await git(tmp.path, "show", ":a.txt")).toBe(index)
        const pending = await Review.get(input)
        await Review.decide({
          ...input,
          expectedCheckout: pending.checkout,
          decision: "accept",
          files: pending.files.map((file) => ({ file: file.file, version: file.version })),
        })
        expect((await Review.get(input)).files).toEqual([])
        expect(await git(tmp.path, "show", ":a.txt")).toBe(index)
        expect(await git(tmp.path, "rev-parse", "HEAD")).toBe(head)
      },
    })
  },
)

test("rejecting a staged new file removes only the working file", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "new.txt")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Snapshot.track(session.id)
      await Snapshot.trackFile(file, session.id)
      await Filesystem.write(file, "new\n")
      await git(tmp.path, "add", ".")
      const input = { scope: "session" as const, sessionID: session.id }
      const shown = await Review.get(input)
      await Review.decide({
        ...input,
        expectedCheckout: shown.checkout,
        decision: "reject",
        files: shown.files.map((file) => ({ file: file.file, version: file.version })),
      })
      expect(await Filesystem.exists(file)).toBe(false)
      expect(await git(tmp.path, "show", ":new.txt")).toBe("new\n")
      const changes = await GitChanges.get()
      expect(changes.staged.map((file) => [file.file, file.status])).toEqual([["new.txt", "added"]])
      expect(changes.unstaged.map((file) => [file.file, file.status])).toEqual([["new.txt", "deleted"]])
    },
  })
})

test("binary agent edits are restored as whole files without changing the index", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "image.bin")
  await Filesystem.write(file, new Uint8Array([0, 1, 2]))
  await git(tmp.path, "add", ".")
  await git(tmp.path, "commit", "-m", "image")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Snapshot.track(session.id)
      await Snapshot.trackFile(file, session.id)
      await Filesystem.write(file, new Uint8Array([0, 9, 8]))
      const input = { scope: "session" as const, sessionID: session.id }
      const shown = await Review.get(input)
      expect(shown.files[0]).toMatchObject({ binary: true, hunks: 1 })
      await Review.decide({
        ...input,
        expectedCheckout: shown.checkout,
        decision: "reject",
        files: shown.files.map((file) => ({ file: file.file, version: file.version })),
      })
      expect([...(await Filesystem.readBytes(file))]).toEqual([0, 1, 2])
    },
  })
})
