import { afterEach, expect, test } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Backend, type State } from "../src/backend"

const fake = path.join(import.meta.dirname, "fixture", "fake-serve.mjs")
const running: Backend[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((backend) => backend.stop()))
})

function backend(env: NodeJS.ProcessEnv = {}, delays = [50, 50, 50]) {
  const created = new Backend({
    executable: [process.execPath, fake],
    env: () => env,
    cwd: os.tmpdir(),
    log: () => {},
    delays,
    timeout: 10_000,
  })
  running.push(created)
  return created
}

const until = async (check: () => boolean, timeout = 10_000) => {
  for (let waited = 0; !check() && waited < timeout; waited += 50) await new Promise((r) => setTimeout(r, 50))
  expect(check()).toBe(true)
}

test("starts the backend and returns its address and token once ready, listening on 127.0.0.1 only", async () => {
  const endpoint = await backend().start()
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(endpoint.headers.authorization).toMatch(/^Basic .{30,}$/)
  // The backend is started as the desktop client
  const res = await fetch(endpoint.url, { headers: endpoint.headers })
  expect(await res.json()).toMatchObject({ auth: endpoint.headers.authorization, client: "desktop" })
})

test("restarts after an unexpected exit on the same port with a new token", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backend-")), "crash")
  fs.writeFileSync(file, "1")
  const created = backend({ FAKE_CRASH_FILE: file })
  const states: State[] = []
  created.on("state", (state) => states.push(state))
  const first = await created.start()
  await until(() => states.filter((state) => state === "ready").length === 2)
  expect(states).toContain("restarting")
  expect(created.endpoint!.port).toBe(first.port)
  expect(created.endpoint!.headers.authorization).not.toBe(first.headers.authorization)
  expect((await fetch(created.endpoint!.url)).status).toBe(200)
})

test("stays failed after repeated crashes and recovers on manual retry", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backend-")), "crash")
  fs.writeFileSync(file, "10")
  const created = backend({ FAKE_CRASH_FILE: file })
  await created.start()
  await until(() => created.state === "failed")
  fs.writeFileSync(file, "0")
  const endpoint = await created.restart()
  expect(created.state).toBe("ready")
  expect((await fetch(endpoint.url)).status).toBe(200)
})

test("a failed first start reports the error and stays failed without a restart loop", async () => {
  const created = backend({ FAKE_FAIL: "1" })
  const states: State[] = []
  created.on("state", (state) => states.push(state))
  await expect(created.start()).rejects.toThrow("exited before it started listening")
  expect(states).toEqual(["starting", "failed"])
  // The error keeps the last child output so the UI can show the cause
  expect(created.error).toContain("libatomic.so.1")
})

test("stop closes the channel and the backend exits on its own", async () => {
  const created = backend()
  await created.start()
  const exit = new Promise<number | null>((resolve) => created.once("exit", resolve))
  await created.stop()
  expect(await exit).toBe(0)
  expect(created.state).toBe("stopped")
})
