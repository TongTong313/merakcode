import { expect, test, vi } from "vitest"
import { persistent } from "../../lib/persistence"
import { fileOwners, releaseFile, retainFile } from "./references"
import { encodeDir } from "../../lib/route"

test("canonical directory spelling retains owners from the legacy bucket", async () => {
  await persistent.set(`file-links-${encodeDir("D:/legacy-links")}`, "notes.txt", JSON.stringify(["chat-a", "chat-b"]))
  expect(await fileOwners("D:\\legacy-links", "notes.txt")).toEqual(["chat-a", "chat-b"])
  expect(await releaseFile("D:\\legacy-links", "notes.txt", "chat-a")).toEqual(["chat-b"])
  expect(await fileOwners("D:/legacy-links", "notes.txt")).toEqual(["chat-b"])
})

test("file aliases share references and querying owners does not write", async () => {
  await retainFile("/reference-alias", "src/../notes.txt", "chat-a")
  await retainFile("/reference-alias", "/reference-alias/notes.txt", "chat-b")
  const writes = vi.spyOn(persistent, "set")
  try {
    expect(await fileOwners("/reference-alias", "notes.txt")).toEqual(["chat-a", "chat-b"])
    expect(writes).not.toHaveBeenCalled()
    expect(await releaseFile("/reference-alias", "./notes.txt", "chat-a")).toEqual(["chat-b"])
    expect(await fileOwners("/other-tree", "notes.txt")).toEqual([])
  } finally {
    writes.mockRestore()
  }
})
