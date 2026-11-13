import { mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { persistent } from "../../lib/persistence"
import { encodeDir } from "../../lib/route"
import { client } from "../../state/client"
import { fileOwners, releaseFile, retainFile } from "./references"

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

test("canonical directory spelling retains owners from the legacy bucket", async () => {
  const target = await folder("legacy-links")
  const link = path.join(path.dirname(env.project), `legacy-links-alias-${folders}`)
  await symlink(target, link, "junction")
  await persistent.set(`file-links-${encodeDir(link)}`, "notes.txt", JSON.stringify(["chat-a", "chat-b"]))
  expect(await fileOwners(target, "notes.txt")).toEqual(["chat-a", "chat-b"])
  expect(await releaseFile(target, "notes.txt", "chat-a")).toEqual(["chat-b"])
  expect(await fileOwners(target, "notes.txt")).toEqual(["chat-b"])
  expect(await persistent.entries(`file-links-${encodeDir(link)}`)).toEqual([])
})

test("file aliases share references and querying owners does not write", async () => {
  const directory = await folder("reference-alias")
  await retainFile(directory, "src/../notes.txt", "chat-a")
  await retainFile(directory, `${directory}/notes.txt`, "chat-b")
  const writes = vi.spyOn(persistent, "set")
  expect(await fileOwners(directory, "notes.txt")).toEqual(["chat-a", "chat-b"])
  expect(writes).not.toHaveBeenCalled()
  expect(await releaseFile(directory, "./notes.txt", "chat-a")).toEqual(["chat-b"])
  expect(await fileOwners(await folder("other-tree"), "notes.txt")).toEqual([])
})
