import { expect, test, vi } from "vitest"
import { flushDrafts, readDraft, writeDraft } from "./draft"
import { persistent } from "../../lib/persistence"

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
