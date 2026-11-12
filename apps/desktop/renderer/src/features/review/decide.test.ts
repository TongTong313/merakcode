import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { checkoutOf, refreshBranches } from "../../state/git"
import type { ReviewKey } from "./cache"
import { decideReview, loadReview, reviewDetail, undoReview } from "./state"

let env: Awaited<ReturnType<typeof engineFixture>>
const lines = (...rows: string[]) => rows.map((row) => `${row}\n`).join("")
const original = lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l")
const edited = lines("A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "L")

beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "notes.txt"), original)
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
  await refreshBranches(env.project)
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

/** A conversation that starts now; the agent's edits are made by hand afterwards */
async function conversation(): Promise<ReviewKey> {
  const connection = await client()
  const created = await connection.session.create({ provider: "fake", model: "test", workdir: env.project })
  await writeFile(path.join(env.project, "notes.txt"), edited)
  await writeFile(path.join(env.project, "added.txt"), "added\n")
  return {
    directory: env.project,
    scope: "session",
    sessionID: created.session,
    checkout: checkoutOf(env.project) ?? null,
  }
}
const file = (name: string) => path.join(env.project, name)

test("the review of a conversation lists its changes and offers to accept and reject them", async () => {
  const input = await conversation()
  const result = await loadReview(input)
  expect(result?.files.map((item) => item.file).toSorted()).toEqual(["added.txt", "notes.txt"])
  expect(result?.actions).toEqual({ accept: true, reject: true })
  expect(result?.last).toBeUndefined()
})

test("rejecting one hunk of a file writes the rest back and leaves the other hunk in the review", async () => {
  const input = await conversation()
  const before = await loadReview(input)
  const firstHunk = (await reviewDetail(
    input,
    before!.files.find((item) => item.file === "notes.txt")!,
  ))!.hunks[0]!.id
  await decideReview(input, "reject", [{ file: "notes.txt", hunks: [firstHunk] }])
  expect(await readFile(file("notes.txt"), "utf8")).toBe(
    lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "L"),
  )
  const after = await loadReview(input)
  expect(after?.files.find((item) => item.file === "notes.txt")?.hunks).toBe(1)
  expect(after?.last).toEqual({ decision: "reject", count: 1 })
})

test("accepting everything empties the review without touching files, and undo brings it back", async () => {
  const input = await conversation()
  await loadReview(input)
  await decideReview(input, "accept")
  expect(await readFile(file("notes.txt"), "utf8")).toBe(edited)
  const accepted = await loadReview(input)
  expect(accepted?.files).toEqual([])
  expect(accepted?.last).toEqual({ decision: "accept", count: 2 })
  await undoReview(input)
  const back = await loadReview(input)
  expect(back?.files.map((item) => item.file).toSorted()).toEqual(["added.txt", "notes.txt"])
  expect(back?.last).toBeUndefined()
})

test("a decision about a file that changed since it was listed is refused with the stale code", async () => {
  const input = await conversation()
  await loadReview(input)
  await writeFile(file("added.txt"), "added, then edited\n")
  await expect(decideReview(input, "reject", [{ file: "added.txt" }])).rejects.toThrow(/MRK-4030/)
  expect(await readFile(file("added.txt"), "utf8")).toBe("added, then edited\n")
})
