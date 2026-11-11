import { mkdtemp, mkdir, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "vitest"
import { Storage } from "../src/storage"

test("failed migration writes leave the previous value available for retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "merakcode-storage-"))
  try {
    const storage = new Storage(directory)
    storage.set("layouts", "chat", "old drafts")
    const target = path.join(directory, "layouts.json")
    await rename(target, `${target}.backup`)
    await mkdir(target)
    expect(() => storage.set("layouts", "chat", "merged drafts")).toThrow()
    expect(storage.get("layouts", "chat")).toBe("old drafts")
    await rm(target, { recursive: true })
    storage.set("layouts", "chat", "merged drafts")
    expect(new Storage(directory).get("layouts", "chat")).toBe("merged drafts")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
