import { afterAll, afterEach, beforeAll, expect, test } from "vitest"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { connect } from "@merakcode/sdk"
import { SqliteStore } from "@merakcode/sdk/store"
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
  await Promise.all(running.splice(0).map((backend) => backend.stop()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true })
})

async function backend() {
  const home = await mkdtemp(path.join(tmpdir(), "merak-desktop-home-"))
  homes.push(home)
  const script = path.join(home, "replies.json")
  await writeFile(script, JSON.stringify([{ text: "Desktop host reply" }]))
  const created = new Backend({
    executable: [binary],
    env: () => ({ MERAKCODE_HOME: home }),
    cwd: home,
    serve: ["--script", script],
    log: () => {},
    delays: [25, 25],
    timeout: 5000,
  })
  running.push(created)
  return { created, home }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (check()) return
    await delay(25)
  }
  throw new Error("Backend did not reach the expected state")
}

test("hosts the real Go engine and closes storage after the durable shutdown event", async () => {
  const { created, home } = await backend()
  const endpoint = await created.start()
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(endpoint.headers.authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
  expect(created.client?.hello.store).toBe("accepted")
  const info = JSON.parse(await readFile(path.join(home, "engine.json"), "utf8"))
  const observer = await connect(info)
  try {
    const session = await observer.session.create({ provider: "fake", workdir: home })
    const finished = Promise.withResolvers<void>()
    await observer.events.subscribe({ scope: { session: session.session }, types: ["turn.finished"] }, () =>
      finished.resolve(),
    )
    await observer.session.send({ session: session.session, parts: [{ text: "Hello" }] })
    await finished.promise
    await created.stop()
    const storage = new SqliteStore(path.join(home, "merak.db"))
    try {
      expect(storage.find({ types: ["engine.shutdown"] })).toHaveLength(1)
      expect(storage.find({ scope: { session: session.session }, types: ["message.completed"] })).toHaveLength(1)
    } finally {
      storage.close()
    }
    expect(created.state).toBe("stopped")
  } finally {
    await observer.close()
  }
}, 15000)

test("restarts a crashed engine on the same port with a new token", async () => {
  const { created, home } = await backend()
  const first = await created.start()
  const info = JSON.parse(await readFile(path.join(home, "engine.json"), "utf8"))
  process.kill(info.pid)
  await until(() => created.endpoint?.headers.authorization !== first.headers.authorization)
  expect(created.state).toBe("ready")
  expect(created.endpoint?.port).toBe(first.port)
  expect(created.endpoint?.headers.authorization).not.toBe(first.headers.authorization)
  expect(created.client?.hello.store).toBe("accepted")
}, 15000)

test("attaches to an existing local-store engine as an ordinary client", async () => {
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
      info = await readFile(path.join(home, "engine.json"), "utf8")
        .then(JSON.parse)
        .catch(() => undefined)
      if (!info) await delay(25)
    }
    expect(info?.pid).toBe(child.pid)
    const endpoint = await created.start()
    expect(endpoint.port).toBe(Number(new URL(info!.endpoint).port))
    expect(created.client?.hello.store).toBe("declined")
    expect((await created.client!.session.create({ provider: "fake" })).session).toBeTruthy()
    await created.stop()
    await exited
    expect(child.exitCode).toBe(0)
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
    const info = JSON.parse(await readFile(path.join(home, "engine.json"), "utf8"))
    process.kill(info.pid)
    await until(() => created.state === "failed" || created.endpoint?.headers.authorization !== token)
  }
  expect(created.state).toBe("failed")
  await created.restart()
  expect(created.state).toBe("ready")
}, 20000)
