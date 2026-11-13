import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createRoot } from "solid-js"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { useGitChanges } from "../features/git/changes"
import { engineFixture } from "../test/engine"
import { client } from "./client"
import { updateCheckout } from "./git"
import { bootstrap, closeFolder, connect, ensureSession, listen, loadProviders, setState, state } from "./store"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture({ replies: Array.from({ length: 16 }, () => ({ text: "Feedback received" })) })
  location.href = env.url
  await writeFile(path.join(env.project, "tracked.txt"), "tracked\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

test("startup retains a folder that is not there and keeps provider reads working", async () => {
  const offline = path.join(env.project, "..", "volume-that-is-gone", "folder")
  const previous = localStorage.getItem("ui:folders")
  localStorage.setItem("ui:folders", JSON.stringify([offline]))
  try {
    await expect(bootstrap()).resolves.toBeUndefined()
    expect(state.folders.map((folder) => folder.directory)).toEqual([offline])
    expect(state.config).toBeDefined()
    const models = state.models
    await expect(loadProviders()).resolves.toBeUndefined()
    expect(state.models.map((model) => model.id)).toEqual(models.map((model) => model.id))
    await expect(closeFolder(offline)).resolves.toBeUndefined()
    expect(state.folders).toEqual([])
  } finally {
    if (previous === null) localStorage.removeItem("ui:folders")
    else localStorage.setItem("ui:folders", previous)
    setState("folders", [])
  }
})

test("a listener that throws does not stop other listeners or the conversation view", async () => {
  const connection = await client()
  const seen: string[] = []
  const stopBroken = listen((_directory, event) => {
    if (event.type === "session.created" || event.type === "turn.started") throw new Error("Listener failure probe")
  })
  const unlisten = listen((directory, event) => {
    if (["session.created", "turn.started", "turn.finished"].includes(event.type))
      seen.push(`${event.type}:${directory}`)
  })
  const disconnect = connect()
  try {
    const id = (await connection.session.create({ provider: "fake", model: "test", workdir: env.project })).session
    await expect.poll(() => seen, { timeout: 15_000 }).toEqual([`session.created:${env.project}`])
    await ensureSession(id)
    await connection.session.send({ session: id, parts: [{ text: "Hello" }] })
    await expect
      .poll(() => seen, { timeout: 20_000 })
      .toEqual([`session.created:${env.project}`, `turn.started:${env.project}`, `turn.finished:${env.project}`])
    await expect
      .poll(() => state.views[id]?.state.messages?.some((message) => message.role === "assistant"), { timeout: 15_000 })
      .toBe(true)
    expect(state.views[id]?.state.status).not.toBe("running")
  } finally {
    disconnect()
    stopBroken()
    unlisten()
  }
})

test("Git changes remain readable when a background refresh arrives during the initial load", async () => {
  await writeFile(path.join(env.project, "new.txt"), "new\n")
  const checkout = (await env.git("rev-parse", "--abbrev-ref", "HEAD")) + ":" + (await env.git("rev-parse", "HEAD"))
  const [branch, ...head] = checkout.split(":")
  const { changes, dispose } = createRoot((dispose) => ({ changes: useGitChanges(() => env.project), dispose }))
  try {
    // The observation lands while the first read is still in flight.
    updateCheckout(env.project, { branch: branch ?? null, head: head.join(":"), checkout })
    await expect.poll(() => changes.data()?.unstaged.map((file) => file.file), { timeout: 15_000 }).toEqual(["new.txt"])
    await expect.poll(() => changes.loading(), { timeout: 15_000 }).toBe(false)
    expect(changes.error()).toBeUndefined()
  } finally {
    dispose()
    vi.restoreAllMocks()
  }
})
