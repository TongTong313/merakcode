import { writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { EngineEvent } from "@merakcode/sdk"
import { engineFixture } from "../test/engine"
import { client } from "./client"
import { connect, listen, openFolder, state } from "./store"

let env: Awaited<ReturnType<typeof engineFixture>>
let disconnect = () => {}
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "note.txt"), "note\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
  await env.git("branch", "feature")
}, 120_000)
afterAll(async () => {
  disconnect()
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

/** Resolves with the first event of the type that passes the test, or fails after the time. */
function nextEvent(type: string, accept: (event: EngineEvent) => boolean, ms = 20_000) {
  return new Promise<EngineEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`no ${type} event arrived`))
    }, ms)
    const stop = listen((_directory, event) => {
      if (event.type !== type || !accept(event)) return
      clearTimeout(timer)
      stop()
      resolve(event)
    })
  })
}

test("an open folder is watched, so a checkout made outside the app reaches the app as repo.changed", async () => {
  disconnect = connect()
  await expect.poll(() => state.connected, { timeout: 30_000 }).toBe(true)
  await openFolder(env.project)
  const changed = nextEvent(
    "repo.changed",
    (event) => event.type === "repo.changed" && event.payload.branch === "feature",
  )
  await env.git("switch", "--quiet", "feature")
  const event = await changed
  expect(event.type === "repo.changed" && event.payload.directory).toBeTruthy()
})

test("a file written outside the app reaches the app as file.changed with its path", async () => {
  const changed = nextEvent(
    "file.changed",
    (event) => event.type === "file.changed" && (event.payload.paths ?? []).includes("made-outside.txt"),
  )
  await writeFile(path.join(env.project, "made-outside.txt"), "hello\n")
  const event = await changed
  expect(event.type === "file.changed" && event.payload.paths).toContain("made-outside.txt")
})
