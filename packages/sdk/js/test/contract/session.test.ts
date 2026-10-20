/**
 * SDK contract: imports only from the package entries and drives a real engine process (with a local fake model).
 */
import { afterAll, beforeAll, expect, test } from "vitest"
import { spawn } from "node:child_process"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createMerakCode, EngineExitedError, MerakCodeError } from "@merakcode/sdk"
import { engine, sandbox, type Sandbox } from "../fixture/engine"
import { fakeModel, type Reply, type Turn } from "../fixture/model"

let script: (turn: Turn) => Reply | Promise<Reply> = () => ({ text: "OK" })
let model: Awaited<ReturnType<typeof fakeModel>>
let env: Sandbox

beforeAll(async () => {
  model = await fakeModel((turn) => script(turn))
  env = await sandbox(model.url)
})

afterAll(async () => {
  await model?.close()
  await env?.[Symbol.asyncDispose]()
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("starts the engine, streams text from a session, and the engine exits on close", async () => {
  script = () => ({ text: "你好，我是假模型" })
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  const pid = merak.pid
  expect(alive(pid)).toBe(true)
  const session = await merak.session()
  let streamed = ""
  let done
  for await (const event of session.run("打个招呼")) {
    if (event.type === "text") streamed += event.delta
    if (event.type === "done") done = event
  }
  expect(streamed).toBe("你好，我是假模型")
  expect(done).toMatchObject({ type: "done", message: { role: "assistant" } })
  await merak.close()
  expect(alive(pid)).toBe(false)
}, 120_000)

test("the model's thinking streams as reasoning events, separate from the reply text", async () => {
  script = () => ({ reasoning: "先想想怎么打招呼", text: "你好" })
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  try {
    const session = await merak.session()
    let thinking = ""
    let text = ""
    for await (const event of session.run("打个招呼")) {
      if (event.type === "reasoning") thinking += event.delta
      if (event.type === "text") text += event.delta
    }
    expect(thinking).toBe("先想想怎么打招呼")
    expect(text).toBe("你好")
  } finally {
    await merak.close()
  }
}, 120_000)

test("the engine process exits when the host process is killed", async () => {
  const host = spawn(
    engine[0]!,
    [
      ...engine.slice(1, -1),
      path.join(import.meta.dirname, "../fixture/host.ts"),
      env.project,
      JSON.stringify(env.env),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let output = ""
  host.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
  host.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
  const pid = await until(() => Number(/ENGINE_PID=(\d+)/.exec(output)?.[1]) || undefined, 60_000)
  expect(alive(pid)).toBe(true)
  host.kill("SIGKILL")
  await until(() => !alive(pid) || undefined, 15_000)
}, 120_000)

test("an engine crash mid-turn makes the iteration throw EngineExitedError instead of hanging", async () => {
  script = () => new Promise<Reply>(() => {})
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  const session = await merak.session()
  const run = (async () => {
    for await (const _ of session.run("慢任务")) {
    }
  })()
  await until(() => model.turns.some((turn) => turn.prompt === "慢任务") || undefined, 60_000)
  process.kill(merak.pid!, "SIGKILL")
  await expect(run).rejects.toBeInstanceOf(EngineExitedError)
  await merak.close()
}, 120_000)

test("the model provider rejects the key: the run yields an error event with code MRK-2001", async () => {
  script = () => ({ status: 401, message: "Incorrect API key provided" })
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  try {
    const session = await merak.session()
    const errors = []
    for await (const event of session.run("hello")) if (event.type === "error") errors.push(event.error)
    expect(errors[0]).toBeInstanceOf(MerakCodeError)
    expect(errors[0]).toMatchObject({ code: "MRK-2001", retryable: false })
  } finally {
    await merak.close()
  }
}, 120_000)

test("asking for a session that does not exist throws NOT_FOUND", async () => {
  const merak = await createMerakCode({ cwd: env.project, executablePath: engine, env: env.env })
  try {
    const error = await merak.session({ id: "ses_doesnotexist" }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(MerakCodeError)
    expect(error).toMatchObject({ code: "MRK-1011", status: 404 })
  } finally {
    await merak.close()
  }
}, 120_000)

async function until<T>(check: () => T | undefined, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await delay(100)
  }
}
