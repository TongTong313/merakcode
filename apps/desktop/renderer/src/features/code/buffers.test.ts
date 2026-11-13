import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { engineFixture } from "../../test/engine"
import { client } from "../../state/client"
import { updateCheckout } from "../../state/git"
import { readDraft } from "./draft"
import { buffersFor, releaseBuffers } from "./state"

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

// The engine answers for real; this only holds a file identity lookup of one folder before it is forwarded.
const held = new Map<string, { entered: () => void; release: Promise<void> }>()
let env: Awaited<ReturnType<typeof engineFixture>>
let engine: Awaited<ReturnType<typeof client>>
let counter = 0
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  engine = await client()
  const identity = engine.file.identity.bind(engine.file)
  engine.file.identity = (async (...args: Parameters<typeof identity>) => {
    const hold = held.get(args[0].directory ?? "")
    hold?.entered()
    await hold?.release
    return identity(...args)
  }) as typeof identity
}, 120_000)
afterAll(async () => {
  try {
    await engine.close()
  } finally {
    await env?.close()
  }
})

/** A real checkout holding a committed notes.txt. */
async function checkout(name: string) {
  const directory = path.join(path.dirname(env.project), `${name}-${++counter}`)
  await mkdir(directory)
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: directory, windowsHide: true })
  await git("init", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("config", "core.autocrlf", "false")
  await writeFile(path.join(directory, "notes.txt"), "committed\n")
  await git("add", ".")
  await git("commit", "-m", "initial")
  return (await engine.file.identity({ directory, path: "." })).directory
}
const edit = (buffer: ReturnType<typeof buffersFor>, file: string, text: string) =>
  (buffer.tabs.find((tab) => tab.path === file)!.model as unknown as { setValue(value: string): void }).setValue(text)

test("closing a file while its identity loads does not reopen its buffer", async () => {
  const directory = await checkout("identity-close")
  const buffer = buffersFor(directory)
  const entered = Promise.withResolvers<void>()
  const resumed = Promise.withResolvers<void>()
  held.set(directory, { entered: () => entered.resolve(), release: resumed.promise })
  const opening = buffer.open("notes.txt")
  try {
    await entered.promise
    await buffer.close("notes.txt")
    resumed.resolve()
    await opening
    expect(buffer.tabs).toHaveLength(0)
  } finally {
    resumed.resolve()
    held.delete(directory)
    await opening
    releaseBuffers(directory)
  }
})

test("a checkout change marks only the buffers of its own worktree as conflicted", async () => {
  const firstDirectory = await checkout("CaseRepo")
  const secondDirectory = await checkout("caserepo")
  const first = buffersFor(firstDirectory)
  const second = buffersFor(secondDirectory)
  try {
    await first.open("notes.txt")
    await second.open("notes.txt")
    edit(first, "notes.txt", "first draft")
    edit(second, "notes.txt", "independent draft")
    await writeFile(path.join(firstDirectory, "notes.txt"), "committed on the next branch\n")
    updateCheckout(firstDirectory, { checkout: "main:head", branch: "main", head: "head" })
    updateCheckout(firstDirectory, { checkout: "next:next", branch: "next", head: "next" }, true)
    await vi.waitFor(() => expect(first.tabs[0]?.conflict).toBe(true))
    await first.reload(true)
    expect(second.tabs[0]?.conflict).toBeFalsy()
    expect(second.tabs[0]?.model?.getValue()).toBe("independent draft")
    await second.close("notes.txt")
  } finally {
    releaseBuffers(firstDirectory)
    releaseBuffers(secondDirectory)
  }
})

test("aliases use one buffer and retain recoverable draft content", async () => {
  const directory = await checkout("buffer-alias")
  const buffer = buffersFor(directory)
  try {
    await buffer.open("src/../notes.txt")
    await buffer.open("notes.txt")
    expect(buffer.tabs).toHaveLength(1)
    edit(buffer, "notes.txt", "Alias draft")
    await buffer.suspend("./notes.txt", "view")
    expect(buffer.tabs).toHaveLength(0)
    expect(await readDraft(directory, "notes.txt")).toMatchObject({ content: "Alias draft" })
    await buffer.close("notes.txt")
  } finally {
    releaseBuffers(directory)
  }
})
