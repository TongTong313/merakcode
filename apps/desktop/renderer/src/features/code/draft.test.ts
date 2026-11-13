import { mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { client } from "../../state/client"
import { unsavedReason } from "../../state/git"
import { flushDrafts, readDraft, restoreDraftProtection, writeDraft } from "./draft"

let env: Awaited<ReturnType<typeof engineFixture>>
let folders = 0
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

/** A real folder next to the fixture project; the engine names it by its canonical form. */
async function folder(name: string) {
  const directory = path.join(path.dirname(env.project), `${name}-${++folders}`)
  await mkdir(directory)
  return realpath(directory)
}

test("canonical directory spelling recovers a legacy draft before removing its old copy", async () => {
  const target = await folder("legacy-draft-tree")
  const link = path.join(path.dirname(env.project), `legacy-draft-link-${folders}`)
  await symlink(target, link, "junction")
  const bucket = `draft-${encodeDir(link)}`
  await persistent.set(
    bucket,
    "notes.txt",
    JSON.stringify({ version: 1, content: "keep alias draft", saved: "original" }),
  )
  expect(await readDraft(target, "notes.txt")).toMatchObject({ content: "keep alias draft" })
  await writeDraft(target, "notes.txt")
  expect(await persistent.entries(bucket)).toEqual([])
  expect(await persistent.entries(`draft-${encodeDir(target)}`)).toEqual([])
})

test("draft guards remain until the last draft is removed and never block another worktree", async () => {
  const guard = await folder("guard-tree")
  const other = await folder("other-guard-tree")
  await writeDraft(guard, "first.txt", { content: "one", saved: "" })
  await writeDraft(guard, "second.txt", { content: "two", saved: "" })
  await restoreDraftProtection(guard)
  expect(unsavedReason(guard)).toBeTruthy()
  await restoreDraftProtection(other)
  expect(unsavedReason(other)).toBeUndefined()
  await writeDraft(guard, "first.txt")
  await restoreDraftProtection(guard)
  expect(unsavedReason(guard)).toBeTruthy()
  await writeDraft(guard, "second.txt")
  await restoreDraftProtection(guard)
  expect(unsavedReason(guard)).toBeUndefined()
})

test("path aliases restore all distinct legacy drafts without merging worktrees", async () => {
  const directory = await folder("alias-drafts")
  const bucket = `draft-${encodeDir(directory)}`
  await persistent.set(bucket, "src/../notes.txt", JSON.stringify({ version: 1, content: "first", saved: "original" }))
  await persistent.set(bucket, "notes.txt", JSON.stringify({ version: 1, content: "second", saved: "original" }))
  const draft = await readDraft(directory, "./notes.txt")
  expect(draft?.content).toBe("second")
  expect(draft).toMatchObject({ alternatives: [{ content: "first" }] })
  expect(await readDraft(await folder("other-tree"), "notes.txt")).toBeUndefined()
  expect(await readDraft(directory, `${directory}/notes.txt`)).toEqual(draft)
  await writeDraft(directory, "src/../notes.txt")
  expect(await persistent.entries(bucket)).toEqual([])
})

test("an edit arriving as storage acknowledges the preceding edit remains durable", async () => {
  const directory = await folder("finish-gap")
  const gate = Promise.withResolvers<void>()
  const original = persistent.set
  const set = vi.spyOn(persistent, "set").mockImplementationOnce((...args) => {
    void original(...args)
    return gate.promise
  })
  try {
    const first = writeDraft(directory, "file.txt", { content: "A", saved: "original" })
    await Promise.resolve()
    let second: Promise<void> | undefined
    gate.resolve()
    queueMicrotask(() => {
      second = writeDraft(directory, "file.txt", { content: "B", saved: "original" })
    })
    await first
    await second
    set.mockRestore()
    vi.resetModules()
    const { readDraft: readAfterReload } = await import("./draft")
    expect(await readAfterReload(directory, "file.txt")).toMatchObject({ content: "B" })
  } finally {
    gate.resolve()
    set.mockRestore()
  }
})

test("a burst of edits flushes only the latest recoverable draft", async () => {
  const directory = await folder("burst-draft")
  const writes = vi.spyOn(persistent, "set")
  const pending = ["a", "ab", "abc"].map((content) => writeDraft(directory, "file.txt", { content, saved: "original" }))
  await flushDrafts()
  await Promise.all(pending)
  expect(await readDraft(directory, "file.txt")).toMatchObject({ content: "abc", saved: "original" })
  expect(writes.mock.calls.filter(([bucket]) => bucket === `draft-${encodeDir(directory)}`)).toHaveLength(1)
})

test("a failed draft write remains recoverable and is retried before closing", async () => {
  const directory = await folder("draft-test")
  const set = vi.spyOn(persistent, "set").mockRejectedValueOnce(new Error("disk unavailable"))
  await expect(writeDraft(directory, "file.txt", { content: "unsaved", saved: "original" })).rejects.toThrow(
    "disk unavailable",
  )
  await flushDrafts()
  set.mockRestore()
  expect(await readDraft(directory, "file.txt")).toMatchObject({ content: "unsaved", saved: "original" })
  expect(await persistent.get(`draft-${encodeDir(directory)}`, "file.txt")).toContain("unsaved")
})

test.each([false, true])("a failed cancellation does not discard a newer user draft: %s", async (edited) => {
  const directory = await folder(`cancelled-draft-${edited}`)
  const bucket = `draft-${encodeDir(directory)}`
  await writeDraft(directory, "notes.txt", { content: "Original draft", saved: "Original file" })
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const entries = persistent.entries
  const read = vi.spyOn(persistent, "entries").mockImplementation(async (value) => {
    if (value !== bucket) return entries(value)
    entered.resolve()
    await gate.promise
    throw new Error("Draft read unavailable")
  })
  try {
    const cancelling = writeDraft(directory, "notes.txt", undefined, "cached")
    await entered.promise
    const editing = edited
      ? writeDraft(directory, "notes.txt", { content: "New user draft", saved: "Original file" })
      : undefined
    gate.resolve()
    await expect(cancelling).rejects.toThrow("Draft read unavailable")
    if (editing) await expect(editing).rejects.toThrow("Draft read unavailable")
    read.mockRestore()
    await flushDrafts()
    expect(await readDraft(directory, "notes.txt")).toMatchObject({
      content: edited ? "New user draft" : "Original draft",
    })
  } finally {
    gate.resolve()
    read.mockRestore()
  }
})

test("a draft is immediately readable while its durable write is still pending", async () => {
  const directory = await folder("pending-draft")
  const gate = Promise.withResolvers<void>()
  const set = vi.spyOn(persistent, "set").mockImplementationOnce(() => gate.promise)
  try {
    const writing = writeDraft(directory, "file.txt", { content: "latest", saved: "original" })
    expect(await readDraft(directory, "file.txt")).toMatchObject({ content: "latest" })
    gate.resolve()
    await writing
  } finally {
    gate.resolve()
    set.mockRestore()
  }
})
