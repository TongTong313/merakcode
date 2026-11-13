import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { connect } from "../src/index"

/** Starts a real `merak serve` with the given environment and returns a connected client. */
async function engine(home: string, env: Record<string, string>) {
  const binary =
    process.env.MERAKCODE_TEST_BINARY ?? path.join(home, process.platform === "win32" ? "merak.exe" : "merak")
  if (!process.env.MERAKCODE_TEST_BINARY)
    await promisify(execFile)("go", ["build", "-o", binary, "./cmd/merak"], {
      cwd: path.resolve(import.meta.dirname, "../../../merak"),
      windowsHide: true,
    })
  const child = spawn(binary, ["serve"], {
    env: { ...process.env, MERAKCODE_HOME: home, ...env },
    stdio: "ignore",
    windowsHide: true,
  })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  let info: { endpoint: string; token: string } | undefined
  for (let attempt = 0; attempt < 250 && !info; attempt++) {
    if (child.exitCode !== null) throw new Error(`Engine exited with ${child.exitCode}`)
    info = await readFile(path.join(home, "data", "engine.json"), "utf8")
      .then((text) => JSON.parse(text) as { endpoint: string; token: string })
      .catch(() => undefined)
    if (!info) await delay(20)
  }
  if (!info) throw new Error("Engine did not publish connection information")
  const client = await connect({ ...info, approve: true })
  return {
    client,
    async stop() {
      client.close()
      child.kill()
      await exited
    },
  }
}

it("model.refresh waits for a provider that answers after 12 seconds", { timeout: 90000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "merakcode-sdk-timeout-"))
  const upstream = createServer((request, response) => {
    if (request.url !== "/models") {
      response.writeHead(404).end()
      return
    }
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "slow-model" }] }))
    }, 12000)
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const running = await engine(home, { OPENAI_BASE_URL: base, OPENAI_API_KEY: "test" })
  try {
    await running.client.config.set({ providers: { openai: { baseURL: base, apiKey: "test" } } })
    const models = await running.client.model.refresh({ provider: "openai" })
    expect(models?.some((model) => model.provider === "openai" && model.id === "slow-model")).toBe(true)
  } finally {
    await running.stop()
    upstream.closeAllConnections()
    upstream.close()
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
})

it("agent.test waits for a command product that answers after 15 seconds", { timeout: 90000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "merakcode-sdk-member-"))
  const running = await engine(home, {})
  // Without a prepared system sandbox the probe asks to start the product unrestricted; approve it
  await running.client.events.subscribe({ types: ["permission.requested"] }, (event) => {
    if (event.type === "permission.requested")
      void running.client.permission.reply({ request: event.id, decision: "allow" })
  })
  try {
    const caps = await running.client.agent.test({
      agent: {
        id: "",
        name: "Slow command",
        summary: "Answers slowly",
        duties: "Reply OK",
        model: { provider: "", model: "" },
        toolPool: "worker.default",
        product: {
          kind: "command",
          binary: "node",
          args: ["-e", "setTimeout(() => console.log('OK'), 15000)"],
        },
      },
    })
    expect(caps.steer).toBe(false)
  } finally {
    await running.stop()
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
})
