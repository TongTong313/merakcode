import { afterEach, beforeEach, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { tmpdir } from "../fixture/fixture"
import { Runtime } from "@merakcode/util/runtime"
import path from "node:path"
import { ConfigEdit } from "@merakcode/engine/config/config-edit"
import fs from "node:fs/promises"
import { Identifier } from "@merakcode/util/id"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { configureConnections } from "../fixture/agent-connections"

beforeEach(async () => {
  await ConfigEdit.commit("global", (text) => ConfigEdit.set(text, ["agentConnections", "products"], {}))
})

afterEach(() => Instance.disposeAll())

test("updates external conversation activity only after a message is admitted", async () => {
  await using tmp = await tmpdir()
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "activity-fixture"], {
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdout.write('Reply')"],
    }),
  )
  const app = Server.App()
  const request = (url: string, body?: unknown) =>
    app.request(
      `${url}?directory=${encodeURIComponent(tmp.path)}`,
      body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
    )
  const created = await (
    await request("/session", { target: { kind: "external", productID: "activity-fixture" } })
  ).json()
  const current = async () => (await request(`/session/${created.id}`)).json()
  let previous = created.time.updated
  for (const text of ["First turn", "Second turn"]) {
    await expect.poll(() => Date.now()).toBeGreaterThan(previous)
    const reply = await (
      await request(`/session/${created.id}/message`, {
        parts: [{ type: "text", text }],
        permissionMode: "ask",
      })
    ).json()
    expect(reply.info.terminal).toBe("completed")
    const updated = await current()
    expect(updated.time.updated).toBeGreaterThan(previous)
    previous = updated.time.updated
  }
  await request("/agent-connection/product", { type: "enabled", id: "activity-fixture", enabled: false })
  const blocked = await current()
  const messages = await (await request(`/session/${created.id}/message`)).json()
  const rejected = await request(`/session/${created.id}/prompt_async`, { parts: [{ type: "text", text: "Blocked" }] })
  expect(rejected.status).toBe(409)
  expect((await current()).time.updated).toBe(blocked.time.updated)
  expect(await (await request(`/session/${created.id}/message`)).json()).toEqual(messages)
})

test.each([-60_000, 60_000])(
  "replays the previous assistant reply with a client clock offset of %i ms",
  async (offset) => {
    await using tmp = await tmpdir()
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", "clock-fixture"], {
        command: process.execPath,
        adapter: "command",
        args: [
          "--input-type=module",
          "-e",
          "let text = ''; for await (const chunk of process.stdin) text += chunk; process.stdout.write('REPLY: ' + text)",
        ],
      }),
    )
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(tmp.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const { id } = await (
      await request("/session", { target: { kind: "external", productID: "clock-fixture" } })
    ).json()
    const clientTime = Date.now() + offset
    const first = await (
      await request(`/session/${id}/message`, {
        messageID: Identifier.create("message", false, clientTime),
        parts: [{ type: "text", text: "Keep the grapefruit marker" }],
      })
    ).json()
    expect(first.info.terminal).toBe("completed")
    const original = await (await request(`/session/${id}/message`)).json()
    const reply = await (
      await request(`/session/${id}/message`, {
        messageID: Identifier.create("message", false, clientTime + 1),
        parts: [{ type: "text", text: "What was the marker?" }],
      })
    ).json()
    expect(reply.info.terminal).toBe("completed")
    expect(reply.parts.map((part: { text?: string }) => part.text ?? "").join("")).toContain(
      "assistant: REPLY: Keep the grapefruit marker",
    )
    const final = await (await request(`/session/${id}/message`)).json()
    expect(final.slice(0, original.length)).toEqual(original)
    expect(final.map((message: { info: { role: string } }) => message.info.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
  },
)

test.each([
  [1, false, false],
  [2, false, false],
  [1, true, false],
  [2, false, true],
  [1, true, true],
  [1, true, "blank"],
  [1, true, "whitespace"],
] as const)(
  "calibrates the final reply with %i streamed parts (empty: %s, final: %s)",
  async (partCount, empty, final) => {
    await using tmp = await tmpdir()
    const gate = path.join(tmp.path, "release-final-text")
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", "final"], {
        command: process.execPath,
        adapter: "member",
        args: [
          ...Runtime.execArgv(),
          path.join(import.meta.dirname, "fixture/external-adapter.ts"),
          final ? "final-parts" : "final-text",
          String(partCount),
          typeof final === "string" ? final : empty ? "empty" : "complete",
        ],
      }),
    )
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(tmp.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const created = await request("/session", { target: { kind: "external", productID: "final" } })
    expect(created.status).toBe(200)
    const { id } = await created.json()
    const last = async () => {
      const response = await request(`/session/${id}/message`)
      const body = await response.json()
      expect(body).toEqual(expect.any(Array))
      return (
        body as {
          info: { terminal?: string }
          parts: { id: string; text?: string }[]
        }[]
      ).at(-1)!
    }
    try {
      await request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: `gate:${gate}` }] })
      await expect.poll(async () => (await last()).parts[final ? 1 : 0]?.text, { timeout: 5_000 }).toBe("Hello ")
      const before = (await last()).parts
      const streamed = before[final ? 1 : 0]!
      await fs.writeFile(gate, "release")
      await expect
        .poll(async () => (await last()).info.terminal, { timeout: 5_000 })
        .toBe(empty ? "failed" : "completed")
      expect((await last()).parts).toEqual([
        ...(final ? [expect.objectContaining({ id: before[0]!.id, text: "Earlier commentary" })] : []),
        expect.objectContaining({ id: streamed.id, text: empty ? "Hello " : "Hello world" }),
      ])
    } finally {
      await fs.writeFile(gate, "release")
      await request(`/session/${id}/abort`, {})
    }
  },
)

test("creates an external conversation without a native model", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await Server.App().request("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "External", target: { kind: "external", productID: "claude" } }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        target: { kind: "external", productID: "claude" },
        targetRevision: 0,
      })
    },
  })
})

test.each([
  ["zh-CN", "产品已关闭"],
  ["en-US", "The product is disabled"],
] as const)("reports a disabled external target in %s", async (locale, message) => {
  await using tmp = await tmpdir({ config: { locale } })
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "disabled-locale"], {
      command: process.execPath,
      enabled: false,
    }),
  )
  const response = await Server.App().request(`/session?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { kind: "external", productID: "disabled-locale" } }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: "MRK-4006", data: { message } })
})

test.each([
  ["zh-CN", "malformed", "适配器返回的结果格式无效"],
  ["en-US", "malformed", "The adapter returned an invalid result"],
  ["zh-CN", "malformed-text", "适配器发送的正文事件格式无效"],
  ["en-US", "malformed-text", "The adapter sent an invalid text event"],
  ["zh-CN", "malformed-step", "适配器发送的步骤事件格式无效"],
  ["en-US", "malformed-step", "The adapter sent an invalid step event"],
] as const)("reports an invalid adapter reply in %s (%s)", async (locale, fixture, message) => {
  await using tmp = await tmpdir({ config: { locale } })
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "invalid-locale"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "../agent-connection/adapter-fixture.ts"), fixture],
    }),
  )
  const app = Server.App()
  const request = (url: string, body: unknown) =>
    app.request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const { id } = await (await request("/session", { target: { kind: "external", productID: "invalid-locale" } })).json()
  const response = await request(`/session/${id}/message`, { parts: [{ type: "text", text: "Reply" }] })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    info: { terminal: "failed", error: { code: "MRK-4009", data: { message } } },
  })
})

test("blocks a disabled external conversation before accepting async input", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = Server.App()
      const request = (url: string, body?: unknown) =>
        app.request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const created = await request("/session", { target: { kind: "external", productID: "codex" } })
      const session = (await created.json()) as { id: string }
      await ConfigEdit.commit("global", (text) =>
        ConfigEdit.set(text, ["agentConnections", "products", "codex"], { enabled: false }),
      )
      const response = await request(`/session/${session.id}/prompt_async`, {
        parts: [{ type: "text", text: "must not run" }],
      })
      expect(response.status).toBe(409)
      expect(await (await request(`/session/${session.id}/message`)).json()).toEqual([])
      expect(await (await request(`/session/${session.id}`)).json()).toMatchObject({
        target: { kind: "external", productID: "codex" },
        targetBlock: { decision: "pending" },
      })
    },
  })
})

test("persists a declined takeover for the same disable cycle", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const created = await request("/session", { target: { kind: "external", productID: "opencode" } })
      const { id } = (await created.json()) as { id: string }
      await ConfigEdit.commit("global", (text) =>
        ConfigEdit.set(text, ["agentConnections", "products", "opencode"], { enabled: false }),
      )
      const blocked = (await (await request(`/session/${id}`)).json()) as {
        targetRevision: number
        targetBlock: { blockID: string }
      }
      const response = await request(`/session/${id}/takeover`, {
        decision: "decline",
        expectedTargetRevision: blocked.targetRevision,
        blockID: blocked.targetBlock.blockID,
      })
      expect(response.status).toBe(200)
      const declined = (await response.json()) as { targetRevision: number }
      await ConfigEdit.commit("global", (text) =>
        ConfigEdit.set(text, ["agentConnections", "products", "opencode", "title"], "Renamed"),
      )
      expect(await (await request(`/session/${id}`)).json()).toMatchObject({
        target: { kind: "external", productID: "opencode" },
        targetRevision: declined.targetRevision,
        targetBlock: { blockID: blocked.targetBlock.blockID, decision: "declined" },
      })
    },
  })
})

test.each(["accept", "decline"] as const)(
  "rejects an old %s after a deleted product ID is registered again disabled",
  async (decision) => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(tmp.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const product = {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
    }
    expect((await request("/agent-connection/product", { type: "add", id: "reused", product })).status).toBe(200)
    const { id } = await (await request("/session", { target: { kind: "external", productID: "reused" } })).json()
    expect((await request("/agent-connection/product", { type: "enabled", id: "reused", enabled: false })).status).toBe(
      200,
    )
    const original = await (await request(`/session/${id}`)).json()
    expect((await request("/agent-connection/product", { type: "remove", id: "reused" })).status).toBe(200)
    const configured = await app.request("/global/config?skipDispose=true", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentConnections: { products: { reused: { ...product, enabled: false, title: "Replacement" } } },
      }),
    })
    expect(configured.status).toBe(200)
    const stale = await request(`/session/${id}/takeover`, {
      decision,
      expectedTargetRevision: original.targetRevision,
      blockID: original.targetBlock.blockID,
    })
    expect(stale.status).toBe(409)
    const current = await (await request(`/session/${id}`)).json()
    expect(current.target).toEqual({ kind: "external", productID: "reused" })
    expect(current.targetBlock).toMatchObject({ productID: "reused", decision: "pending" })
    expect(current.targetBlock.disabledCycleID).not.toBe(original.targetBlock.disabledCycleID)
    expect(current.targetRevision).toBeGreaterThan(original.targetRevision)
    expect(
      (
        await request(`/session/${id}/takeover`, {
          decision,
          expectedTargetRevision: current.targetRevision,
          blockID: current.targetBlock.blockID,
        })
      ).status,
    ).toBe(200)
  },
)

test("takes over only the explicitly accepted conversation and rejects stale decisions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const first = (await (
        await request("/session", { target: { kind: "external", productID: "claude" } })
      ).json()) as { id: string }
      const second = (await (
        await request("/session", { target: { kind: "external", productID: "claude" } })
      ).json()) as { id: string }
      await ConfigEdit.commit("global", (text) =>
        ConfigEdit.set(text, ["agentConnections", "products", "claude"], { enabled: false }),
      )
      const block = (await (await request(`/session/${first.id}`)).json()) as {
        targetRevision: number
        targetBlock: { blockID: string }
      }
      const decision = {
        decision: "accept",
        expectedTargetRevision: block.targetRevision,
        blockID: block.targetBlock.blockID,
      }
      const accepted = await request(`/session/${first.id}/takeover`, decision)
      expect(accepted.status).toBe(200)
      const result = await accepted.json()
      expect(result).toMatchObject({
        id: first.id,
        target: { kind: "merak" },
        takeover: { fromProductID: "claude", blockID: decision.blockID },
      })
      expect(await (await request(`/session/${first.id}/takeover`, decision)).json()).toEqual(result)
      expect(await (await request(`/session/${second.id}`)).json()).toMatchObject({
        target: { kind: "external", productID: "claude" },
        targetBlock: { decision: "pending" },
      })
      expect((await request(`/session/${second.id}/takeover`, decision)).status).toBe(409)
    },
  })
})

test("stops an external turn and preserves its streamed partial text", async () => {
  await using tmp = await tmpdir({ git: true })
  const gate = path.join(tmp.path, "release")
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "stop-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const { id } = (await (
        await request("/session", { target: { kind: "external", productID: "stop-fixture" } })
      ).json()) as { id: string }
      type Reply = { info: { role: string; terminal?: string }; parts: { text?: string }[] }
      const messages = async () => (await (await request(`/session/${id}/message`)).json()) as Reply[]
      try {
        expect(
          (await request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: `gate:${gate}` }] })).status,
        ).toBe(204)
        await expect
          .poll(
            async () =>
              (await messages())
                .at(-1)
                ?.parts.map((p) => p.text ?? "")
                .join(""),
            { timeout: 5000 },
          )
          .toBe("Hello ")
        expect((await request(`/session/${id}/abort`, {})).status).toBe(200)
        await expect.poll(async () => (await messages()).at(-1)?.info.terminal, { timeout: 5000 }).toBe("cancelled")
        expect(
          (await messages())
            .at(-1)
            ?.parts.map((p) => p.text ?? "")
            .join(""),
        ).toBe("Hello ")
      } finally {
        await fs.writeFile(gate, "release")
      }
    },
  })
}, 20_000)

test("cancels the active external product when it is disabled", async () => {
  await using tmp = await tmpdir({ git: true })
  const gate = path.join(tmp.path, "release-disabled")
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "disable-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const { id } = (await (
        await request("/session", { target: { kind: "external", productID: "disable-fixture" } })
      ).json()) as { id: string }
      type Reply = { info: { terminal?: string }; parts: { text?: string }[] }
      const last = async () => ((await (await request(`/session/${id}/message`)).json()) as Reply[]).at(-1)
      try {
        await request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: `gate:${gate}` }] })
        await expect.poll(async () => (await last())?.parts[0]?.text, { timeout: 5000 }).toBe("Hello ")
        const disabled = await request("/agent-connection/product", {
          type: "enabled",
          id: "disable-fixture",
          enabled: false,
        })
        expect(disabled.status).toBe(200)
        await expect.poll(async () => (await last())?.info.terminal, { timeout: 5000 }).toBe("cancelled")
        expect((await last())?.parts[0]?.text).toBe("Hello ")
      } finally {
        await fs.writeFile(gate, "release")
      }
    },
  })
}, 20_000)

test("queues external turns and reads the model when each turn starts", async () => {
  await using tmp = await tmpdir({ git: true })
  const gate = path.join(tmp.path, "release-queue")
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "queue-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
      model: { id: "model-A" },
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const { id } = (await (
        await request("/session", { target: { kind: "external", productID: "queue-fixture" } })
      ).json()) as { id: string }
      type Reply = {
        info: { role: string; terminal?: string; execution: { requestedModel?: { id: string } } }
        parts: { text?: string }[]
      }
      const replies = async () =>
        ((await (await request(`/session/${id}/message`)).json()) as Reply[]).filter((m) => m.info.role === "assistant")
      try {
        await request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: `gate:${gate}` }] })
        await expect.poll(async () => (await replies())[0]?.parts[0]?.text, { timeout: 5000 }).toBe("Hello ")
        await request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: "second turn" }] })
        await expect.poll(async () => (await replies()).length).toBe(2)
        expect((await replies())[1]?.parts).toEqual([])
        await ConfigEdit.commit("global", (text) =>
          ConfigEdit.set(text, ["agentConnections", "products", "queue-fixture", "model"], { id: "model-B" }),
        )
        await fs.writeFile(gate, "release")
        await expect
          .poll(async () => (await replies()).map((m) => m.info.terminal), { timeout: 5000 })
          .toEqual(["completed", "completed"])
        expect((await replies()).map((m) => m.info.execution.requestedModel?.id)).toEqual(["model-A", "model-B"])
      } finally {
        await fs.writeFile(gate, "release")
      }
    },
  })
}, 20_000)

test("rejects native commands and history mutations on an external conversation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const { id } = (await (
        await request("/session", { target: { kind: "external", productID: "claude" } })
      ).json()) as { id: string }
      expect((await request(`/session/${id}/fork`, {})).status).toBe(400)
      expect((await request(`/session/${id}/command`, { command: "compact", arguments: "" })).status).toBe(400)
    },
  })
})

test.each([
  { route: "message", takeover: false },
  { route: "prompt_async", takeover: false },
  { route: "message", takeover: true },
  { route: "prompt_async", takeover: true },
])(
  "rejects editing an existing external message before accepting $route (takeover: $takeover)",
  async ({ route, takeover }) => {
    await using tmp = await tmpdir({ git: true })
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", "history-fixture"], {
        command: process.execPath,
        adapter: "member",
        args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
      }),
    )
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(tmp.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const { id } = await (
      await request("/session", { target: { kind: "external", productID: "history-fixture" } })
    ).json()
    await (await request(`/session/${id}/message`, { parts: [{ type: "text", text: "ORIGINAL" }] })).text()
    const original = await (await request(`/session/${id}/message`)).json()
    const user = original.find((message: { info: { role: string } }) => message.info.role === "user")
    if (takeover) {
      await ConfigEdit.commit("global", (text) =>
        ConfigEdit.set(text, ["agentConnections", "products", "history-fixture", "enabled"], false),
      )
      const blocked = await (await request(`/session/${id}`)).json()
      const accepted = await request(`/session/${id}/takeover`, {
        decision: "accept",
        expectedTargetRevision: blocked.targetRevision,
        blockID: blocked.targetBlock.blockID,
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({ target: { kind: "merak" } })
    }
    const edited = await request(`/session/${id}/${route}`, {
      messageID: user.info.id,
      parts: [{ id: user.parts[0].id, type: "text", text: "REPLACED" }],
    })
    expect(edited.status).toBe(400)
    expect(await edited.json()).toMatchObject({ code: "MRK-4008" })
    expect(await (await request(`/session/${id}/message`)).json()).toEqual(original)
  },
)

test("rejects moving an existing external text part into a new message", async () => {
  await using tmp = await tmpdir({ git: true })
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "part-history-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
    }),
  )
  const app = Server.App()
  const request = (url: string, body?: unknown) =>
    app.request(
      `${url}?directory=${encodeURIComponent(tmp.path)}`,
      body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
    )
  const { id } = await (
    await request("/session", { target: { kind: "external", productID: "part-history-fixture" } })
  ).json()
  await (await request(`/session/${id}/message`, { parts: [{ type: "text", text: "ORIGINAL" }] })).text()
  const original = await (await request(`/session/${id}/message`)).json()
  const user = original.find((message: { info: { role: string } }) => message.info.role === "user")
  const moved = await request(`/session/${id}/prompt_async`, {
    parts: [{ id: user.parts[0].id, type: "text", text: "REPLACED" }],
  })
  expect(moved.status).toBe(400)
  expect(await moved.json()).toMatchObject({ code: "MRK-4008" })
  expect(await (await request(`/session/${id}/message`)).json()).toEqual(original)
})

test.each(["user", "assistant"])(
  "prevents a native command from overwriting an external %s after takeover",
  async (role) => {
    const model = await fakeModel(() => ({ text: "Native reply" }))
    try {
      await using tmp = await tmpdir({
        config: {
          model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      await configureConnections({
        "command-history-fixture": {
          command: process.execPath,
          adapter: "member",
          args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
        },
      })
      const app = Server.App()
      const request = (url: string, body?: unknown) =>
        app.request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const { id } = await (
        await request("/session", { target: { kind: "external", productID: "command-history-fixture" } })
      ).json()
      await (await request(`/session/${id}/message`, { parts: [{ type: "text", text: "ORIGINAL" }] })).text()
      const original = await (await request(`/session/${id}/message`)).json()
      const previous = original.find((message: { info: { role: string } }) => message.info.role === role)
      await request("/agent-connection/product", { type: "enabled", id: "command-history-fixture", enabled: false })
      const blocked = await (await request(`/session/${id}`)).json()
      const takeover = await request(`/session/${id}/takeover`, {
        decision: "accept",
        expectedTargetRevision: blocked.targetRevision,
        blockID: blocked.targetBlock.blockID,
      })
      expect(takeover.status).toBe(200)
      const command = { command: "context", arguments: "", model: "alibaba-cn/qwen-plus" }
      const edited = await request(`/session/${id}/command`, { ...command, messageID: previous.info.id })
      expect(edited.status).toBe(400)
      expect(await edited.json()).toMatchObject({ code: "MRK-4008" })
      expect(await (await request(`/session/${id}/message`)).json()).toEqual(original)
      const fresh = await request(`/session/${id}/command`, { ...command, messageID: Identifier.ascending("message") })
      expect(fresh.status).toBe(200)
      const final = await (await request(`/session/${id}/message`)).json()
      expect(final.slice(0, original.length)).toEqual(original)
      expect(final).toHaveLength(original.length + 2)
    } finally {
      await model.close()
    }
  },
)

test.each([0, 60_000])(
  "admits a client message ID only once across racing sends and retry (clock offset: %i)",
  async (offset) => {
    await using tmp = await tmpdir({ git: true })
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", "concurrent-history-fixture"], {
        command: process.execPath,
        adapter: "member",
        args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
      }),
    )
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(tmp.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const { id } = await (
      await request("/session", { target: { kind: "external", productID: "concurrent-history-fixture" } })
    ).json()
    const messageID = Identifier.create("message", false, Date.now() + offset)
    const responses = await Promise.all(
      ["FIRST", "SECOND"].map((text) =>
        request(`/session/${id}/message`, {
          messageID,
          parts: [{ type: "text", text }],
          metadata: { tag: "kept", externalClientMessageID: "spoofed" },
        }),
      ),
    )
    await Promise.all(responses.map((response) => response.text()))
    const messages = await (await request(`/session/${id}/message`)).json()
    expect(messages.filter((message: { info: { role: string } }) => message.info.role === "assistant")).toHaveLength(1)
    expect(messages).toHaveLength(2)
    if (!offset) expect(messages[0].info.id).toBe(messageID)
    expect(messages[0].info.metadata.tag).toBe("kept")
    expect(messages[0].parts).toHaveLength(1)
    expect(messages[1].info.terminal).toBe("completed")
    expect(messages[1].parts[0].text).toMatch(/^Hello world /)
    const retried = await request(`/session/${id}/message`, { messageID, parts: [{ type: "text", text: "RETRY" }] })
    expect(retried.status).toBe(400)
    expect(await retried.json()).toMatchObject({ code: "MRK-4008" })
    expect(await (await request(`/session/${id}/message`)).json()).toEqual(messages)
  },
)

test.each([false, true])(
  "replays saved text history without resume support (session line: %s)",
  async (hasSessionLine) => {
    await using tmp = await tmpdir({ git: true })
    await ConfigEdit.commit("global", (text) =>
      ConfigEdit.set(text, ["agentConnections", "products", "replay-fixture"], {
        command: process.execPath,
        adapter: "command",
        sessionLine: hasSessionLine ? "^SESSION: (.+)$" : undefined,
        args: [
          "--input-type=module",
          "-e",
          `let text = ''; for await (const chunk of process.stdin) text += chunk; process.stdout.write(${hasSessionLine ? "'SESSION: ignored-thread\\n' + text" : "text"})`,
        ],
      }),
    )
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const request = (url: string, body: unknown) =>
          Server.App().request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        const { id } = (await (
          await request("/session", { target: { kind: "external", productID: "replay-fixture" } })
        ).json()) as { id: string }
        const first = await (
          await request(`/session/${id}/message`, { parts: [{ type: "text", text: "Remember the blue square" }] })
        ).json()
        expect(first.info.terminal).toBe("completed")
        const reply = (await (
          await request(`/session/${id}/message`, { parts: [{ type: "text", text: "What shape?" }] })
        ).json()) as { info: { terminal: string }; parts: { text?: string }[] }
        expect(reply.info.terminal).toBe("completed")
        const output = reply.parts.map((part) => part.text ?? "").join("")
        expect(output).toContain("user: Remember the blue square")
        expect(output).toContain("Current user task:\nWhat shape?")
        expect(output).not.toContain("SESSION:")
      },
    })
  },
)

test("passes a globally configured command model to a direct conversation", async () => {
  await using tmp = await tmpdir()
  await configureConnections({
    "command-model": {
      command: process.execPath,
      adapter: "command",
      args: ["-e", "process.stdin.resume(); process.stdout.write(process.argv[1])", "{model}"],
      model: { id: "configured-command-model" },
    },
  })
  const app = Server.App()
  const request = (url: string, body: unknown) =>
    app.request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const { id } = await (await request("/session", { target: { kind: "external", productID: "command-model" } })).json()
  const response = await request(`/session/${id}/message`, {
    parts: [{ type: "text", text: "Use the configured model" }],
  })
  expect(response.status).toBe(200)
  const reply = await response.json()
  expect(reply.info).toMatchObject({
    terminal: "completed",
    execution: { requestedModel: { id: "configured-command-model" } },
  })
  expect(reply.parts.map((part: { text?: string }) => part.text ?? "").join("")).toBe("configured-command-model")
})

test("rejects unknown products and external targets on collaboration groups", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const create = (body: unknown) =>
        Server.App().request(`/session?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      expect((await create({ target: { kind: "external", productID: "missing-product" } })).status).toBe(400)
      expect(
        (await create({ target: { kind: "external", productID: "claude" }, metadata: { group: true } })).status,
      ).toBe(400)
    },
  })
})

test("preserves observed external tool steps without inventing tool results", async () => {
  await using tmp = await tmpdir({ git: true })
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "steps-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body: unknown) =>
        Server.App().request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const { id } = (await (
        await request("/session", { target: { kind: "external", productID: "steps-fixture" } })
      ).json()) as { id: string }
      const reply = (await (
        await request(`/session/${id}/message`, { parts: [{ type: "text", text: "show a step" }] })
      ).json()) as { info: { metadata?: unknown } }
      expect(reply.info.metadata).toEqual({ externalSteps: [{ tool: "Read", detail: "README.md" }] })
    },
  })
})

test("applies a readonly turn mode over a previously stored auto mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "permission-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body: unknown) =>
        Server.App().request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const { id } = (await (
        await request("/session", { target: { kind: "external", productID: "permission-fixture" } })
      ).json()) as { id: string }
      expect((await request(`/session/${id}/permission-mode`, { permissionMode: "auto" })).status).toBe(200)
      const reply = (await (
        await request(`/session/${id}/message`, {
          permissionMode: "readonly",
          parts: [{ type: "text", text: "ask to write" }],
        })
      ).json()) as { parts: { text?: string }[] }
      expect(reply.parts.map((part) => part.text ?? "").join("")).toBe("allow:false")
    },
  })
})

test("sends an external text turn without configuring a native provider", async () => {
  await using tmp = await tmpdir({ git: true })
  await ConfigEdit.commit("global", (text) =>
    ConfigEdit.set(text, ["agentConnections", "products", "direct-fixture"], {
      command: process.execPath,
      adapter: "member",
      args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
      model: { id: "fixture-explicit" },
    }),
  )
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const request = (url: string, body?: unknown) =>
        Server.App().request(
          `${url}?directory=${encodeURIComponent(tmp.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const created = await request("/session", { target: { kind: "external", productID: "direct-fixture" } })
      const session = (await created.json()) as { id: string }
      const response = await request(`/session/${session.id}/message`, { parts: [{ type: "text", text: "hello" }] })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).not.toBe("")
      const reply = JSON.parse(body) as { info: { execution: unknown }; parts: { type: string; text?: string }[] }
      expect(reply.info.execution).toMatchObject({
        kind: "external",
        productID: "direct-fixture",
        actualModel: { id: "fixture-explicit" },
      })
      expect(
        reply.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
      ).toMatch(/^Hello world \(.+; fixture-explicit\)$/)
    },
  })
})
