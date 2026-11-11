import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { execFile, spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { connect } from "@merakcode/sdk"
import { Backend } from "../src/backend"

let buildDir: string
let binary: string
const running: Backend[] = []
const homes: string[] = []
beforeAll(async () => {
  buildDir = await mkdtemp(path.join(tmpdir(), "merak-desktop-build-"))
  binary = path.join(buildDir, process.platform === "win32" ? "merak.exe" : "merak")
  await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
    cwd: path.resolve(import.meta.dirname, "../../../../merak"),
  })
}, 30000)
afterEach(async () => {
  // The engine outlives the app, so every test ends by stopping the one it started
  await Promise.all(running.splice(0).map((backend) => backend.shutdown()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true })
})

function create(home: string) {
  const created = new Backend({
    executable: [binary],
    env: () => ({ MERAKCODE_HOME: home }),
    cwd: home,
    serve: ["--script", path.join(home, "replies.json")],
    log: () => {},
    delays: [25, 25],
    timeout: 5000,
  })
  running.push(created)
  return created
}

async function backend() {
  const home = await mkdtemp(path.join(tmpdir(), "merak-desktop-home-"))
  homes.push(home)
  await writeFile(path.join(home, "replies.json"), JSON.stringify([{ text: "Desktop host reply" }]))
  return { created: create(home), home }
}

const connectionFile = (home: string) => path.join(home, "data", "engine.json")
const readInfo = async (home: string) => JSON.parse(await readFile(connectionFile(home), "utf8"))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await check()) return
    await delay(25)
  }
  throw new Error("Backend did not reach the expected state")
}

test("hosts the real Go engine as a client of its protocol", async () => {
  const { created, home } = await backend()
  const endpoint = await created.start()
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(endpoint.headers.authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
  expect(created.client?.hello.human).toBe("local-human")
  const observer = await connect(await readInfo(home))
  try {
    const session = await observer.session.create({ provider: "fake", workdir: home })
    const finished = Promise.withResolvers<void>()
    await observer.events.subscribe({ scope: { session: session.session }, types: ["turn.finished"] }, () =>
      finished.resolve(),
    )
    await observer.session.send({ session: session.session, parts: [{ text: "Hello" }] })
    await finished.promise
  } finally {
    await observer.close()
  }
}, 15000)

test("the engine keeps running when the app disconnects, and the next start joins the same process", async () => {
  const { created, home } = await backend()
  await created.start()
  const { pid } = await readInfo(home)
  await created.stop()
  expect(created.state).toBe("stopped")
  expect(alive(pid)).toBe(true)

  const next = create(home)
  await next.start()
  expect((await readInfo(home)).pid).toBe(pid)
  expect((await next.client!.session.create({ provider: "fake", workdir: home })).session).toBeTruthy()
}, 20000)

test("shutdown stops the engine and removes its connection file", async () => {
  const { created, home } = await backend()
  await created.start()
  const { pid } = await readInfo(home)
  await created.shutdown()
  expect(created.state).toBe("stopped")
  await until(() => !alive(pid))
  await expect(access(connectionFile(home))).rejects.toThrow()
}, 20000)

test("restarts a crashed engine on the same port with a new token", async () => {
  const { created, home } = await backend()
  const first = await created.start()
  process.kill((await readInfo(home)).pid)
  await until(() => created.endpoint?.headers.authorization !== first.headers.authorization)
  expect(created.state).toBe("ready")
  expect(created.endpoint?.port).toBe(first.port)
  expect(created.endpoint?.headers.authorization).not.toBe(first.headers.authorization)
}, 15000)

test("attaches to an engine somebody else started and leaves it running", async () => {
  const { created, home } = await backend()
  const child = spawn(binary, ["serve", "--script", path.join(home, "replies.json")], {
    env: { ...process.env, MERAKCODE_HOME: home },
    windowsHide: true,
    stdio: "ignore",
  })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  try {
    let info: { pid: number; endpoint: string } | undefined
    for (let attempt = 0; attempt < 200 && !info; attempt++) {
      info = await readInfo(home).catch(() => undefined)
      if (!info) await delay(25)
    }
    expect(info?.pid).toBe(child.pid)
    const endpoint = await created.start()
    expect(endpoint.port).toBe(Number(new URL(info!.endpoint).port))
    expect((await created.client!.session.create({ provider: "fake", workdir: home })).session).toBeTruthy()
    await created.stop()
    expect(child.exitCode).toBeNull()
    expect(alive(child.pid!)).toBe(true)
  } finally {
    child.kill()
    await exited
  }
}, 15000)

test("exhausts automatic restart attempts and allows a manual retry", async () => {
  const { created, home } = await backend()
  await created.start()
  for (let count = 0; count < 3; count++) {
    const token = created.endpoint!.headers.authorization
    process.kill((await readInfo(home)).pid)
    await until(() => created.state === "failed" || created.endpoint?.headers.authorization !== token)
  }
  expect(created.state).toBe("failed")
  await created.restart()
  expect(created.state).toBe("ready")
}, 20000)
