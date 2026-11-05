import { expect, test, vi } from "vitest"
import { flushDrafts, readDraft, restoreDraftProtection, writeDraft } from "./draft"
import { unsavedReason } from "../../state/git"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"

test("canonical directory spelling recovers a legacy draft before removing its old copy", async () => {
  const bucket = `draft-${encodeDir("D:/legacy-draft-tree")}`
  await persistent.set(
    bucket,
    "notes.txt",
    JSON.stringify({ version: 1, content: "keep alias draft", saved: "original" }),
  )
  expect(await readDraft("D:\\legacy-draft-tree", "notes.txt")).toMatchObject({ content: "keep alias draft" })
  await writeDraft("D:\\legacy-draft-tree", "notes.txt")
  expect(await persistent.entries(bucket)).toEqual([])
})

test("draft guards remain until the last draft is removed and never block another worktree", async () => {
  await writeDraft("/guard-tree", "first.txt", { content: "one", saved: "" })
  await writeDraft("/guard-tree", "second.txt", { content: "two", saved: "" })
  await restoreDraftProtection("/guard-tree")
  expect(unsavedReason("/guard-tree")).toBeTruthy()
  await restoreDraftProtection("/other-guard-tree")
  expect(unsavedReason("/other-guard-tree")).toBeUndefined()
  await writeDraft("/guard-tree", "first.txt")
  await restoreDraftProtection("/guard-tree")
  expect(unsavedReason("/guard-tree")).toBeTruthy()
  await writeDraft("/guard-tree", "second.txt")
  await restoreDraftProtection("/guard-tree")
  expect(unsavedReason("/guard-tree")).toBeUndefined()
})

test("path aliases restore all distinct legacy drafts without merging worktrees", async () => {
  const bucket = `draft-${encodeDir("/alias-drafts")}`
  await persistent.set(bucket, "src/../notes.txt", JSON.stringify({ version: 1, content: "first", saved: "original" }))
  await persistent.set(bucket, "notes.txt", JSON.stringify({ version: 1, content: "second", saved: "original" }))
  const draft = await readDraft("/alias-drafts", "./notes.txt")
  expect(draft?.content).toBe("second")
  expect(draft).toMatchObject({ alternatives: [{ content: "first" }] })
  expect(await readDraft("/other-tree", "notes.txt")).toBeUndefined()
  expect(await readDraft("/alias-drafts", "/alias-drafts/notes.txt")).toEqual(draft)
  await writeDraft("/alias-drafts", "src/../notes.txt")
  expect(await persistent.entries(bucket)).toEqual([])
})

test("an edit arriving as storage acknowledges the preceding edit remains durable", async () => {
  const gate = Promise.withResolvers<void>()
  const original = persistent.set
  const set = vi.spyOn(persistent, "set").mockImplementationOnce((...args) => {
    void original(...args)
    return gate.promise
  })
  try {
    const first = writeDraft("/finish-gap", "file.txt", { content: "A", saved: "original" })
    await Promise.resolve()
    let second: Promise<void> | undefined
    gate.resolve()
    queueMicrotask(() => {
      second = writeDraft("/finish-gap", "file.txt", { content: "B", saved: "original" })
    })
    await first
    await second
    set.mockRestore()
    vi.resetModules()
    const { readDraft: readAfterReload } = await import("./draft")
    expect(await readAfterReload("/finish-gap", "file.txt")).toMatchObject({ content: "B" })
  } finally {
    gate.resolve()
    set.mockRestore()
  }
})

test("a burst of edits flushes only the latest recoverable draft", async () => {
  const writes = vi.spyOn(persistent, "set")
  try {
    const pending = ["a", "ab", "abc"].map((content) =>
      writeDraft("/burst-draft", "file.txt", { content, saved: "original" }),
    )
    await flushDrafts()
    await Promise.all(pending)
    expect(await readDraft("/burst-draft", "file.txt")).toMatchObject({ content: "abc", saved: "original" })
    expect(writes).toHaveBeenCalledTimes(1)
  } finally {
    writes.mockRestore()
  }
})

test("a failed draft write remains recoverable and is retried before closing", async () => {
  const set = vi.spyOn(persistent, "set").mockRejectedValueOnce(new Error("disk unavailable"))
  try {
    await expect(writeDraft("/draft-test", "file.txt", { content: "unsaved", saved: "original" })).rejects.toThrow(
      "disk unavailable",
    )
    await flushDrafts()
    expect(await readDraft("/draft-test", "file.txt")).toMatchObject({ content: "unsaved", saved: "original" })
  } finally {
    set.mockRestore()
  }
})

test("a draft is immediately readable while its durable write is still pending", async () => {
  const gate = Promise.withResolvers<void>()
  const set = vi.spyOn(persistent, "set").mockImplementationOnce(() => gate.promise)
  try {
    const writing = writeDraft("/pending-draft", "file.txt", { content: "latest", saved: "original" })
    expect(await readDraft("/pending-draft", "file.txt")).toMatchObject({ content: "latest" })
    gate.resolve()
    await writing
  } finally {
    gate.resolve()
    set.mockRestore()
  }
})
