import { spawn, execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it } from "vitest"
import { connect, type EngineEvent } from "../src/index"

async function startEngine(replies: unknown[]) {
  const home = await mkdtemp(path.join(tmpdir(), "merakcode-sdk-tool-"))
  const binary =
    process.env.MERAKCODE_TEST_BINARY ?? path.join(home, process.platform === "win32" ? "merak.exe" : "merak")
  if (!process.env.MERAKCODE_TEST_BINARY)
    await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
      cwd: path.resolve(import.meta.dirname, "../../../merak"),
    })
  const script = path.join(home, "replies.json")
  await writeFile(script, JSON.stringify(replies))
  const child = spawn(binary, ["serve", "--script", script], {
    env: { ...process.env, MERAKCODE_HOME: home },
    stdio: "ignore",
    windowsHide: true,
  })
  const infoFile = path.join(home, "data", "engine.json")
  for (let attempt = 0; attempt < 250; attempt++) {
    if (child.exitCode !== null) throw new Error(`Engine exited with ${child.exitCode}`)
    const info = await readFile(infoFile, "utf8")
      .then((text) => JSON.parse(text) as { endpoint: string; token: string })
      .catch(() => undefined)
    if (info) return { home, info, stop: () => child.kill() }
    await delay(20)
  }
  child.kill()
  throw new Error("Engine did not publish connection information")
}

const replies = [
  { calls: [{ id: "load", name: "load_tools", input: { names: ["client__weather"] } }] },
  { calls: [{ id: "call", name: "call_tool", input: { name: "client__weather", input: { city: "Paris" } } }] },
  { text: "Done." },
]

async function runTurn(info: { endpoint: string; token: string }, home: string) {
  const watcher = await connect(info)
  const created = await watcher.session.create({ provider: "fake", workdir: home })
  const completed: EngineEvent[] = []
  const finished = Promise.withResolvers<void>()
  await watcher.events.subscribe({ scope: { session: created.session } }, (event) => {
    if (event.type === "tool.completed") completed.push(event)
    if (event.type === "turn.finished") finished.resolve()
  })
  return { watcher, created, completed, finished: finished.promise }
}

it("runs a tool that an SDK client registered and hands the model its result", async () => {
  const engine = await startEngine(replies)
  try {
    const owner = await connect(engine.info)
    const asked: unknown[] = []
    await owner.tool.register(
      { name: "weather", description: "Report the weather of a city.", effect: "read", schema: { type: "object" } },
      (input) => {
        asked.push(input)
        return { text: "Sunny in Paris" }
      },
    )
    const turn = await runTurn(engine.info, engine.home)
    await turn.watcher.session.send({ session: turn.created.session, parts: [{ text: "Weather?" }] })
    await Promise.race([turn.finished, delay(8000).then(() => Promise.reject(new Error("turn did not finish")))])
    expect(asked).toEqual([{ city: "Paris" }])
    const results = turn.completed.filter((event) => JSON.stringify(event.payload).includes("Sunny in Paris"))
    expect(results.length).toBe(1)
    await turn.watcher.close()
    await owner.close()
  } finally {
    engine.stop()
  }
}, 60000)

it("fails a call of a client tool once its client has disconnected", async () => {
  const engine = await startEngine(replies)
  try {
    const owner = await connect(engine.info)
    await owner.tool.register(
      { name: "weather", description: "Report the weather of a city.", effect: "read" },
      () => ({
        text: "unused",
      }),
    )
    const turn = await runTurn(engine.info, engine.home)
    await owner.close()
    await turn.watcher.session.send({ session: turn.created.session, parts: [{ text: "Weather?" }] })
    await Promise.race([turn.finished, delay(8000).then(() => Promise.reject(new Error("turn did not finish")))])
    expect(turn.completed.some((event) => JSON.stringify(event.payload).includes("Sunny"))).toBe(false)
    expect(turn.completed.some((event) => JSON.stringify(event.payload).includes('"isError":true'))).toBe(true)
    await turn.watcher.close()
  } finally {
    engine.stop()
  }
}, 60000)
