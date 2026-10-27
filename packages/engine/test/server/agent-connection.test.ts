import { afterEach, beforeEach, expect, test } from "vitest"
import { Filesystem } from "@merakcode/util/filesystem"
import { globalConfigFile } from "@merakcode/util/paths"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import { shim } from "../collaboration/fixture/shim"
import fs from "node:fs/promises"
import { Runtime } from "@merakcode/util/runtime"
import { configureConnections } from "../fixture/agent-connections"

beforeEach(async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: {
          claude: { enabled: false, command: "missing-claude-fixture" },
          codex: { enabled: false },
          opencode: { enabled: false },
        },
      },
    }),
  )
  Config.invalidateScope("global")
})

afterEach(async () => {
  await Filesystem.write(globalConfigFile(), JSON.stringify({ $schema: Config.SCHEMA }))
  Config.invalidateScope("global")
  await Instance.disposeAll()
})

test.each(["disable", "remove", "update"] as const)(
  "keeps a delayed product probe consistent with a concurrent %s",
  async (action) => {
    await using project = await tmpdir()
    const gate = path.join(project.path, "release-inspect")
    await configureConnections({
      delayed: {
        enabled: false,
        adapter: "member",
        command: process.execPath,
        args: [
          ...Runtime.execArgv(),
          path.join(import.meta.dirname, "fixture/external-adapter.ts"),
          "inspect-gate",
          gate,
        ],
      },
    })
    const app = Server.App()
    const url = `/agent-connection/product?directory=${encodeURIComponent(project.path)}`
    const change = (body: unknown) =>
      app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const pending = change({ type: "enabled", id: "delayed", enabled: true })
    try {
      await expect
        .poll(
          () =>
            fs.access(`${gate}.started`).then(
              () => true,
              () => false,
            ),
          { timeout: 10_000 },
        )
        .toBe(true)
      if (action === "disable")
        expect((await change({ type: "enabled", id: "delayed", enabled: false })).status).toBe(200)
      if (action === "remove") expect((await change({ type: "remove", id: "delayed" })).status).toBe(200)
      if (action === "update") {
        const changed = await app.request("/global/config?skipDispose=true", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentConnections: { products: { delayed: { title: "Updated", model: { id: "next-model" } } } },
          }),
        })
        expect(changed.status).toBe(200)
      }
      await fs.writeFile(gate, "release")
      const late = await pending
      expect(late.status).toBe(200)
      const result = (await late.json()).find((item: { id: string }) => item.id === "delayed")
      if (action === "remove") expect(result).toBeUndefined()
      if (action === "disable") expect(result).toMatchObject({ enabled: false, connected: false })
      if (action === "update")
        expect(result).toMatchObject({ enabled: true, connected: true, title: "Updated", model: { id: "next-model" } })
      const current = (await (await app.request(url)).json()).find((item: { id: string }) => item.id === "delayed")
      expect(result).toEqual(current)
    } finally {
      await fs.writeFile(gate, "release")
      await pending
    }
  },
)

test("ignores project connection overrides and reports their source", async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: { products: { claude: { model: { id: "global-model" } } } },
    }),
  )
  Config.invalidateScope("global")
  await using project = await tmpdir({
    init: (directory) =>
      Filesystem.write(
        path.join(directory, "merakcode.json"),
        JSON.stringify({ agentConnections: { products: { claude: { model: { id: "project-model" } } } } }),
      ),
  })
  const query = `directory=${encodeURIComponent(project.path)}`
  const app = Server.App()
  const config = await (await app.request(`/config?${query}`)).json()
  expect(config.agentConnections.products.claude.model.id).toBe("global-model")
  const warnings = await (await app.request(`/config/warnings?${query}`)).json()
  expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ item: "agentConnections" })]))
})

test("lists the same globally configured products in different projects", async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: {
          claude: { enabled: false },
          codex: { enabled: false },
          opencode: { enabled: false },
          fixture: { title: "Fixture", command: "missing-fixture-cli", enabled: false, model: { id: "explicit" } },
        },
      },
    }),
  )
  Config.invalidateScope("global")
  await using first = await tmpdir()
  await using second = await tmpdir()
  const app = Server.App()
  const read = (directory: string) =>
    app.request(`/agent-connection/product?directory=${encodeURIComponent(directory)}`)
  const response = await read(first.path)
  expect(response.status).toBe(200)
  const firstList = await response.json()
  const secondList = await (await read(second.path)).json()
  expect(firstList).toEqual(secondList)
  expect(firstList).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "merak", enabled: true, source: "builtin" }),
      expect.objectContaining({ id: "fixture", title: "Fixture", source: "global", model: { id: "explicit" } }),
    ]),
  )
})

test("adds a product through the global connection route", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/agent-connection/product?directory=${encodeURIComponent(project.path)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "add",
        id: "added",
        product: { command: "missing-added-cli", adapter: "member", model: { id: "selected" } },
      }),
    },
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "added", model: { id: "selected" }, source: "global", enabled: true }),
    ]),
  )
})

test("updates a product model without changing its enabled state", async () => {
  await using project = await tmpdir()
  const query = `directory=${encodeURIComponent(project.path)}`
  const response = await Server.App().request(`/agent-connection/product?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "update", id: "claude", product: { title: "Renamed", model: { id: "next-model" } } }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "claude", title: "Renamed", enabled: false, model: { id: "next-model" } }),
    ]),
  )
})

test("changes a global product switch and advances its revision only once", async () => {
  await using project = await tmpdir()
  const query = `directory=${encodeURIComponent(project.path)}`
  const app = Server.App()
  const before = (await (await app.request(`/agent-connection/product?${query}`)).json()).find(
    (item: { id: string }) => item.id === "claude",
  )
  const change = () =>
    app.request(`/agent-connection/product?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "enabled", id: "claude", enabled: true }),
    })
  const changed = await change()
  expect(changed.status).toBe(200)
  const enabled = (await changed.json()).find((item: { id: string }) => item.id === "claude")
  expect(enabled.enabled).toBe(true)
  expect(enabled.revision).toBeGreaterThan(before.revision)
  const repeated = (await (await change()).json()).find((item: { id: string }) => item.id === "claude")
  expect(repeated.revision).toBe(enabled.revision)
})

test("removes a custom product from the global catalog", async () => {
  await using project = await tmpdir()
  const url = `/agent-connection/product?directory=${encodeURIComponent(project.path)}`
  const app = Server.App()
  const change = (body: unknown) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  await change({ type: "add", id: "removed", product: { command: "missing-removed-cli" } })
  const response = await change({ type: "remove", id: "removed" })
  expect(response.status).toBe(200)
  expect((await response.json()).some((item: { id: string }) => item.id === "removed")).toBe(false)
})

test("does not expose the removed collaboration product route", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(`/collaboration/product?directory=${encodeURIComponent(project.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(response.status).toBe(404)
})

test("warns about removed product configuration without reading it", async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      collaboration: { products: { legacy: { command: "missing-legacy-cli" } } },
    }),
  )
  Config.invalidateScope("global")
  await using project = await tmpdir()
  const query = `directory=${encodeURIComponent(project.path)}`
  const app = Server.App()
  const config = await (await app.request(`/config?${query}`)).json()
  expect(config.collaboration?.products).toBeUndefined()
  expect(await (await app.request(`/config/warnings?${query}`)).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ item: "collaboration.products" })]),
  )
})

test("rejects project writes of global connection settings", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(`/config?directory=${encodeURIComponent(project.path)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentConnections: { products: { extra: { command: "missing-extra-cli" } } } }),
  })
  expect(response.status).toBe(400)
  expect((await response.json()).code).toBe("MRK-3002")
})

test("requires a provider for an explicitly selected OpenCode model", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/agent-connection/product?directory=${encodeURIComponent(project.path)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "update", id: "opencode", product: { model: { id: "model-only" } } }),
    },
  )
  expect(response.status).toBe(400)
  expect((await response.json()).code).toBe("MRK-3002")
})

test("rejects duplicate model and protocol switches in adapter arguments", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/agent-connection/product?directory=${encodeURIComponent(project.path)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "update",
        id: "claude",
        product: { model: { id: "selected" }, args: ["--model", "conflicting"] },
      }),
    },
  )
  expect(response.status).toBe(400)
})

test.each([
  ["zh-CN", "额外参数不能覆盖模型、适配器协议或权限设置：--model"],
  ["en-US", "Extra arguments cannot override the model, protocol, or permission settings: --model"],
] as const)("localizes conflicting arguments loaded from global configuration in %s", async (locale, message) => {
  await using project = await tmpdir({ config: { locale } })
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: {
          claude: { command: process.execPath, args: ["--model", "conflicting"] },
          codex: { enabled: false },
          opencode: { enabled: false },
        },
      },
    }),
  )
  Config.invalidateScope("global")
  const app = Server.App()
  const query = `directory=${encodeURIComponent(project.path)}`
  const response = await app.request(`/agent-connection/product?${query}`)
  expect(response.status).toBe(200)
  const products = await response.json()
  const product = products.find((product: { id: string }) => product.id === "claude")
  expect(product).toMatchObject({
    connected: false,
    reason: message,
  })
  const models = await app.request(`/agent-connection/product/claude/model?${query}`)
  expect(models.status).toBe(400)
  expect(await models.json()).toMatchObject({ code: "MRK-3002", data: { message } })
  const verification = await app.request(`/agent-connection/product/claude/verify?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: product.revision }),
  })
  expect(verification.status).toBe(400)
  expect(await verification.json()).toMatchObject({ code: "MRK-3002", data: { message } })
})

test("rejects a command model without an argument placeholder", async () => {
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/agent-connection/product?directory=${encodeURIComponent(project.path)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "add",
        id: "bad-command",
        product: { command: "missing-command", adapter: "command", model: { id: "selected" } },
      }),
    },
  )
  expect(response.status).toBe(400)
})

test.each([
  ["zh-CN", { args: ["{model}"] }, "模型配置必须与首次及续接参数中的 {model} 占位符一致"],
  [
    "en-US",
    { args: ["{model}"] },
    "The model setting must match the {model} placeholder in initial and resume arguments",
  ],
  ["zh-CN", { args: [], model: { id: "selected" } }, "模型配置必须与首次及续接参数中的 {model} 占位符一致"],
  [
    "zh-CN",
    { args: ["{model}"], resumeArgs: [], model: { id: "selected" } },
    "模型配置必须与首次及续接参数中的 {model} 占位符一致",
  ],
] as const)("rejects inconsistent global command model arguments in %s (%j)", async (locale, fields, message) => {
  await using project = await tmpdir({ config: { locale } })
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: {
          claude: { enabled: false },
          codex: { enabled: false },
          opencode: { enabled: false },
          "missing-command-model": { command: process.execPath, adapter: "command", ...fields },
        },
      },
    }),
  )
  Config.invalidateScope("global")
  const response = await Server.App().request(
    `/agent-connection/product/missing-command-model/model?directory=${encodeURIComponent(project.path)}`,
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    code: "MRK-3002",
    data: { message },
  })
})

test("discovers model choices without claiming account access", async () => {
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: { claude: { command: process.execPath }, codex: { enabled: false }, opencode: { enabled: false } },
      },
    }),
  )
  Config.invalidateScope("global")
  await using project = await tmpdir()
  const response = await Server.App().request(
    `/agent-connection/product/claude/model?directory=${encodeURIComponent(project.path)}`,
  )
  expect(response.status).toBe(200)
  const catalog = await response.json()
  expect(catalog.allowCustomID).toBe(true)
  expect(catalog.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "sonnet" })]))
  expect(catalog.models[0].verified).toBeUndefined()
})

test("verifies the saved Claude model through a text-only adapter run", async () => {
  await using project = await tmpdir()
  const command = await shim(project.path, "verify-claude", "claude.ts")
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: {
          claude: { command, model: { id: "fixture-explicit" } },
          codex: { enabled: false },
          opencode: { enabled: false },
        },
      },
    }),
  )
  Config.invalidateScope("global")
  const previous = process.env.CLAUDE_FIXTURE_STREAM
  process.env.CLAUDE_FIXTURE_STREAM = "true"
  try {
    const app = Server.App()
    const query = `directory=${encodeURIComponent(project.path)}`
    const catalog = await (await app.request(`/agent-connection/product?${query}`)).json()
    const product = catalog.find((item: { id: string }) => item.id === "claude")
    const response = await app.request(`/agent-connection/product/claude/verify?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: product.revision }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "passed",
      requestedModel: { id: "fixture-explicit" },
      actualModel: { id: "fixture-explicit" },
      streamingObserved: true,
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_FIXTURE_STREAM
    else process.env.CLAUDE_FIXTURE_STREAM = previous
  }
})

test.each([
  ["zh-CN", "产品未返回回复"],
  ["en-US", "The product returned no reply"],
] as const)("localizes an empty verification reply in %s", async (locale, message) => {
  await using project = await tmpdir({ config: { locale } })
  const command = await shim(project.path, "empty-verify-claude", "claude.ts")
  await Filesystem.write(
    globalConfigFile(),
    JSON.stringify({
      $schema: Config.SCHEMA,
      agentConnections: {
        products: { claude: { command }, codex: { enabled: false }, opencode: { enabled: false } },
      },
    }),
  )
  Config.invalidateScope("global")
  const previous = process.env.CLAUDE_FIXTURE_REPLY
  process.env.CLAUDE_FIXTURE_REPLY = ""
  try {
    const app = Server.App()
    const query = `directory=${encodeURIComponent(project.path)}`
    const products = await (await app.request(`/agent-connection/product?${query}`)).json()
    const product = products.find((item: { id: string }) => item.id === "claude")
    const response = await app.request(`/agent-connection/product/claude/verify?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: product.revision }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "failed",
      error: { code: "MRK-4009", message },
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_FIXTURE_REPLY
    else process.env.CLAUDE_FIXTURE_REPLY = previous
  }
})
