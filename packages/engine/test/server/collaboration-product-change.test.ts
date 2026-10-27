import { beforeEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import { parse } from "jsonc-parser"
import { globalConfigFile } from "@merakcode/util/paths"
import { Config } from "../../src/config/config"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"

beforeEach(async () => configureConnections({}))

async function changes(fn: (change: (body: unknown) => Promise<Response>) => Promise<void>) {
  await using project = await tmpdir()
  const url = "/agent-connection/product?directory=" + encodeURIComponent(project.path)
  const app = Server.App()
  await fn((body) =>
    Promise.resolve(
      app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    ),
  )
}

test("connection settings preserve unrelated global fields and JSONC comments", async () => {
  await fs.writeFile(
    globalConfigFile(),
    '{\n  // my own note\n  "$schema": "' +
      Config.SCHEMA +
      '",\n  "locale": "zh-CN",\n  "agentConnections": {"products":{"claude":{"enabled":false},"codex":{"enabled":false},"opencode":{"enabled":false}}}\n}\n',
  )
  Config.invalidateScope("global")
  await changes(async (change) => {
    const response = await change({
      type: "add",
      id: "my-agent",
      product: { command: "missing-my-agent", title: "My Agent" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "my-agent", source: "global", builtin: false })]),
    )
  })
  const text = await fs.readFile(globalConfigFile(), "utf8")
  expect(text).toContain("// my own note")
  expect(parse(text).locale).toBe("zh-CN")
})

test("reserved and invalid product identifiers are refused with a coded reason", async () => {
  await changes(async (change) => {
    for (const id of ["merak", "claude", "my agent", ""]) {
      const response = await change({ type: "add", id, product: { command: "missing-cli" } })
      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.code).toMatch(/^MRK-/)
      expect(body.message).toBeTruthy()
    }
  })
})

test("a built-in product cannot be removed and remains available for re-enabling", async () => {
  await changes(async (change) => {
    expect((await change({ type: "remove", id: "claude" })).status).toBe(400)
    const response = await change({ type: "enabled", id: "claude", enabled: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "claude", builtin: true, enabled: false })]),
    )
  })
})

test("a custom product needs a command and a valid session identifier pattern", async () => {
  await changes(async (change) => {
    expect((await change({ type: "add", id: "mine", product: { command: "missing-mine" } })).status).toBe(200)
    for (const body of [
      { type: "add", id: "a", product: { title: "A" } },
      { type: "add", id: "b", product: { command: "  " } },
      { type: "add", id: "c", product: { command: "c", sessionLine: "(" } },
      { type: "update", id: "mine", product: { command: "" } },
      { type: "update", id: "claude", product: { sessionLine: "(" } },
    ]) {
      const response = await change(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect((await response.json()).message).toBeTruthy()
    }
  })
})
