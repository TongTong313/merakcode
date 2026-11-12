import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { refreshBranches } from "../../state/git"
import { buffersFor, releaseBuffers } from "./state"
import { readDraft } from "./draft"

// The code editor is a browser component; a plain text model stands in for it. Everything else is real.
vi.mock("../../lib/monaco", () => ({
  monaco: {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let value = initial
        const listeners: Array<() => void> = []
        return {
          getValue: () => value,
          setValue: (next: string) => {
            value = next
            listeners.forEach((listener) => listener())
          },
          onDidChangeContent: (listener: () => void) => listeners.push(listener),
          dispose() {},
        }
      },
    },
  },
}))

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "notes.txt"), "hello\n")
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

const edit = (buffer: ReturnType<typeof buffersFor>, path: string, text: string) => {
  const model = buffer.tabs.find((tab) => tab.path === path)!.model as unknown as { setValue(value: string): void }
  model.setValue(text)
}

test("a file opens with its checksum and committed baseline, and a save writes it to disk", async () => {
  const buffer = buffersFor(env.project)
  await buffer.open("notes.txt")
  const tab = buffer.tabs.find((item) => item.path === "notes.txt")!
  expect(tab).toMatchObject({ saved: "hello\n", original: "hello\n", dirty: false, missing: undefined })
  expect(tab.checksum).toBeTruthy()
  edit(buffer, "notes.txt", "hello\nworld\n")
  expect(buffer.tabs[0]!.dirty).toBe(true)
  await buffer.save(false, "notes.txt")
  expect(await readFile(path.join(env.project, "notes.txt"), "utf8")).toBe("hello\nworld\n")
  expect(buffer.tabs[0]).toMatchObject({ dirty: false, saved: "hello\nworld\n" })
  expect(await readDraft(env.project, "notes.txt")).toBeUndefined()
})

test("a change made outside the editor is never overwritten by a normal save, and force replaces it", async () => {
  const buffer = buffersFor(env.project)
  const file = path.join(env.project, "notes.txt")
  await writeFile(file, "external\n")
  edit(buffer, "notes.txt", "mine\n")
  await buffer.save(false, "notes.txt")
  expect(await readFile(file, "utf8")).toBe("external\n")
  expect(buffer.tabs[0]!.dirty).toBe(true)
  await buffer.save(true, "notes.txt")
  expect(await readFile(file, "utf8")).toBe("mine\n")
})

test("unsaved work survives closing the view as a draft and blocks releasing the project", async () => {
  const buffer = buffersFor(env.project)
  edit(buffer, "notes.txt", "mine\nunsaved\n")
  expect(releaseBuffers(env.project)).toBe(false)
  await buffer.retain("notes.txt", "view")
  await buffer.suspend("notes.txt", "view")
  expect(await readDraft(env.project, "notes.txt")).toMatchObject({ content: "mine\nunsaved\n" })
  await buffer.close("notes.txt")
  expect(await readDraft(env.project, "notes.txt")).toBeUndefined()
  expect(releaseBuffers(env.project)).toBe(true)
})

test("a path outside the folder cannot be written", async () => {
  const connection = await client()
  await expect(connection.file.write({ directory: env.project, path: "../escape.txt", content: "x" })).rejects.toThrow()
})
