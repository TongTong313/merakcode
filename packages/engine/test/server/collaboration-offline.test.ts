import { afterEach, expect, test } from "vitest"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { Runtime } from "@merakcode/util/runtime"
import { ConfigEdit } from "../../src/config/config-edit"
import { Instance } from "../../src/project/instance"
import path from "node:path"
import fs from "node:fs/promises"
import type { CollaborationGroup, Part, PermissionRequest, QuestionRequest, Todo } from "@merakcode/sdk/client"

afterEach(() => Instance.disposeAll())

test.each([
  ["zh-CN", "model", "MRK-4009", "此适配器不支持指定模型"],
  ["en-US", "model", "MRK-4009", "This adapter does not support selecting a model"],
  ["zh-CN", "empty", "MRK-4009", "unsupported 未返回正文"],
  ["en-US", "empty", "MRK-4009", "unsupported returned no reply"],
  ["zh-CN", "malformed", "MRK-4009", "适配器返回的结果格式无效"],
  ["en-US", "malformed", "MRK-4009", "The adapter returned an invalid result"],
  ["zh-CN", "config", "MRK-3002", "额外参数不能覆盖模型、适配器协议或权限设置：--model"],
  [
    "en-US",
    "config",
    "MRK-3002",
    "Extra arguments cannot override the model, protocol, or permission settings: --model",
  ],
] as const)("reports a member adapter failure with an MRK code in %s (%s)", async (locale, kind, code, message) => {
  const model = await fakeModel((turn) =>
    turn.results.length
      ? { text: "Leader finished" }
      : { tool: "delegate", args: { seat: "Member", task: "Reply once" } },
  )
  try {
    await configureConnections({
      unsupported: {
        command: process.execPath,
        adapter: "member",
        args: [
          ...Runtime.execArgv(),
          path.join(
            import.meta.dirname,
            kind === "empty" ? "fixture/external-adapter.ts" : "../agent-connection/adapter-fixture.ts",
          ),
          ...(kind === "empty" ? ["final-text", "1", "empty"] : ["malformed"]),
        ],
        model: kind === "model" ? { id: "chosen-model" } : undefined,
      },
    })
    await using project = await tmpdir({
      git: true,
      config: {
        locale,
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(project.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const { sessionID } = await (
      await request("/collaboration", {
        leader: { name: "Leader" },
        seats: [{ name: "Member", product: "unsupported", role: "Developer", duty: "Reply" }],
      })
    ).json()
    if (kind === "config")
      await ConfigEdit.commit("global", (text) =>
        ConfigEdit.set(text, ["agentConnections", "products", "unsupported"], {
          command: process.execPath,
          adapter: "claude",
          args: ["--model", "override"],
        }),
      )
    await (await request(`/session/${sessionID}/message`, { parts: [{ type: "text", text: "Ask the member" }] })).text()
    const messages = (await (await request(`/session/${sessionID}/message`)).json()) as { parts: Part[] }[]
    expect(
      messages.flatMap((entry) => entry.parts).find((part) => part.type === "tool" && part.tool === "delegate"),
    ).toMatchObject({
      state: { status: "error", error: expect.stringContaining(`${code}: ${message}`) },
    })
  } finally {
    await model.close()
  }
})

test.each([
  [1, false, false],
  [2, false, false],
  [1, true, false],
  [2, false, true],
  [1, true, true],
  [1, true, "blank"],
  [1, true, "whitespace"],
] as const)(
  "calibrates a member's final text with %i streamed parts (empty: %s, final: %s)",
  async (partCount, empty, final) => {
    const model = await fakeModel((turn) =>
      turn.results.length
        ? { text: "Leader finished" }
        : { tool: "delegate", args: { seat: "Member", task: "Reply once" } },
    )
    try {
      await configureConnections({
        final: {
          command: process.execPath,
          adapter: "member",
          args: [
            ...Runtime.execArgv(),
            path.join(import.meta.dirname, "fixture/external-adapter.ts"),
            final ? "final-parts" : "final-text",
            String(partCount),
            typeof final === "string" ? final : empty ? "empty" : "complete",
          ],
        },
      })
      await using project = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      const app = Server.App()
      const request = (url: string, body?: unknown) =>
        app.request(
          `${url}?directory=${encodeURIComponent(project.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const { sessionID } = await (
        await request("/collaboration", {
          leader: { name: "Leader" },
          seats: [{ name: "Member", product: "final", role: "Developer", duty: "Reply" }],
        })
      ).json()
      const response = await request(`/session/${sessionID}/message`, {
        parts: [{ type: "text", text: "Ask the member" }],
      })
      expect(response.status).toBe(200)
      await response.text()
      const messages = (await (await request(`/session/${sessionID}/message`)).json()) as { parts: Part[] }[]
      const delegated = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "delegate")
      expect(delegated).toMatchObject({
        state: {
          status: empty ? "error" : "completed",
          ...(empty ? {} : { output: "Hello world" }),
          metadata: {
            external: {
              terminal: empty ? "failed" : "completed",
              parts: [
                ...(final ? [expect.objectContaining({ text: "Earlier commentary" })] : []),
                expect.objectContaining({ text: empty ? "Hello " : "Hello world" }),
              ],
            },
          },
        },
      })
    } finally {
      await model.close()
    }
  },
)

test("keeps a disabled group member in its original seat and restores it on re-enabling", async () => {
  await configureConnections({ fixture: { command: process.execPath } })
  await using project = await tmpdir()
  const app = Server.App()
  const query = `directory=${encodeURIComponent(project.path)}`
  const created = await (
    await app.request(`/collaboration?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leader: { name: "Leader" },
        seats: [{ name: "Member", product: "fixture", role: "Developer", duty: "Keep this duty" }],
      }),
    })
  ).json()
  const original = created.group.seats.find((seat: { name: string }) => seat.name === "Member")
  const enabled = async (value: boolean) =>
    app.request(`/agent-connection/product?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "enabled", id: "fixture", enabled: value }),
    })
  await enabled(false)
  const read = async () => (await (await app.request(`/collaboration/${created.sessionID}?${query}`)).json()).seats
  const offline = await read()
  expect(offline).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: original.id,
        name: "Member",
        product: "fixture",
        role: "Developer",
        duty: "Keep this duty",
        availability: expect.objectContaining({ state: "offline" }),
      }),
    ]),
  )
  expect(offline.find((seat: { leader: boolean }) => seat.leader).availability.state).toBe("online")
  expect(offline).toHaveLength(2)
  await enabled(true)
  expect(await read()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: original.id, product: "fixture", availability: { state: "online" } }),
    ]),
  )
})

test("reports an installed disabled member as offline and leaves its task pending", async () => {
  const model = await fakeModel((turn) =>
    turn.results.length
      ? { text: "Leader finished" }
      : { tool: "delegate", args: { seat: "Member", task: "Keep this task" } },
  )
  try {
    await configureConnections({
      fixture: {
        command: process.execPath,
        adapter: "member",
        args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
      },
    })
    await using project = await tmpdir({
      git: true,
      config: {
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(project.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const created = await (
      await request("/collaboration", {
        leader: { name: "Leader" },
        seats: [{ name: "Member", product: "fixture", role: "Developer", duty: "Keep this duty" }],
      })
    ).json()
    const id: string = created.sessionID
    expect(
      (await request("/agent-connection/product", { type: "enabled", id: "fixture", enabled: false })).status,
    ).toBe(200)
    const reply = await request(`/session/${id}/message`, { parts: [{ type: "text", text: "Ask the member" }] })
    expect(reply.status).toBe(200)
    await reply.text()
    const messages = (await (await request(`/session/${id}/message`)).json()) as { parts: Part[] }[]
    const delegated = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "delegate")!
    expect(delegated).toMatchObject({
      state: {
        metadata: {
          product: "fixture",
          external: { parts: [], terminal: "cancelled", stopReason: "product-disabled" },
        },
      },
    })
    if (delegated.type !== "tool" || delegated.state.status !== "completed")
      throw new Error("Expected a saved delegation")
    expect(delegated.state.metadata.missing).not.toBe(true)
    const group = (await (await request(`/collaboration/${id}`)).json()) as CollaborationGroup
    expect(group.results).toEqual([])
    expect(group.seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ product: "fixture", availability: { state: "offline", reason: expect.any(String) } }),
      ]),
    )
    const todos = (await (await request(`/session/${id}/todo`)).json()) as Todo[]
    expect(todos).toEqual([expect.objectContaining({ content: "@Member Keep this task", status: "pending" })])
  } finally {
    await model.close()
  }
})

test.each([
  ["zh-CN", "产品已关闭，成员已离线"],
  ["en-US", "The product was disabled; the member is offline"],
] as const)("localizes a member disabled while waiting for its directory in %s", async (locale, message) => {
  const model = await fakeModel((turn) =>
    turn.results.length
      ? { text: "Leader finished" }
      : { tool: "delegate", args: { seat: "Queued", task: "Reply once" } },
  )
  try {
    await configureConnections({
      hold: {
        command: process.execPath,
        adapter: "member",
        args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/lock-adapter.ts")],
      },
      queued: {
        command: process.execPath,
        adapter: "member",
        args: [...Runtime.execArgv(), path.join(import.meta.dirname, "fixture/external-adapter.ts")],
      },
    })
    await using project = await tmpdir({
      git: true,
      config: {
        locale,
        model: "alibaba-cn/qwen-plus",
        small_model: "alibaba-cn/qwen-plus",
        enabled_providers: ["alibaba-cn"],
        provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    const app = Server.App()
    const request = (url: string, body?: unknown) =>
      app.request(
        `${url}?directory=${encodeURIComponent(project.path)}`,
        body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
      )
    const messages = async (id: string) =>
      (await (await request(`/session/${id}/message`)).json()) as { parts: Part[] }[]
    const holder = (await (await request("/session", { target: { kind: "external", productID: "hold" } })).json())
      .id as string
    const gate = path.join(project.path, "release-queued")
    const created = await (
      await request("/collaboration", {
        leader: { name: "Leader" },
        seats: [{ name: "Queued", product: "queued", role: "Developer", duty: "Reply" }],
      })
    ).json()
    const id: string = created.sessionID
    try {
      await request(`/session/${holder}/prompt_async`, { parts: [{ type: "text", text: `hold:${gate}` }] })
      await expect
        .poll(
          async () =>
            (await messages(holder)).at(-1)?.parts.some((part) => part.type === "text" && part.text === "holding"),
          { timeout: 10_000 },
        )
        .toBe(true)
      await request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: "Ask the queued member" }] })
      const delegated = async () =>
        (await messages(id))
          .flatMap((entry) => entry.parts)
          .find((part) => part.type === "tool" && part.tool === "delegate")
      await expect
        .poll(
          async () => {
            const part = await delegated()
            return part?.type === "tool" && part.state.status === "running" && part.state.metadata?.phase === "queued"
          },
          { timeout: 10_000 },
        )
        .toBe(true)
      expect(
        (await request("/agent-connection/product", { type: "enabled", id: "queued", enabled: false })).status,
      ).toBe(200)
      await expect
        .poll(
          async () => {
            const part = await delegated()
            return part?.type === "tool" ? part.state.status : undefined
          },
          { timeout: 10_000 },
        )
        .toBe("error")
      expect(await delegated()).toMatchObject({
        state: {
          error: expect.stringContaining(`MRK-4006: ${message}`),
          metadata: {
            product: "queued",
            external: { parts: [], terminal: "cancelled", stopReason: "product-disabled" },
          },
        },
      })
      expect((await (await request(`/collaboration/${id}`)).json()).results).toEqual([])
      expect((await messages(holder)).at(-1)?.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "holding" })]),
      )
    } finally {
      await fs.writeFile(gate, "release")
      await request(`/session/${id}/abort`, {})
      await request(`/session/${holder}/abort`, {})
    }
  } finally {
    await model.close()
  }
})

test.each(["permission", "question"] as const)(
  "disabling one product preserves another member's pending %s in the same group",
  async (kind) => {
    const model = await fakeModel((turn) =>
      turn.results.length
        ? { text: "Leader finished" }
        : {
            calls: ["a", "b"].map((member) => ({
              tool: "delegate",
              args: { seat: `Member${member}`, task: "Wait for approval", paths: [`${member}/**`] },
            })),
          },
    )
    try {
      await configureConnections(
        Object.fromEntries(
          ["a", "b"].map((member) => [
            `product-${member}`,
            {
              command: process.execPath,
              adapter: "member" as const,
              args: [
                ...Runtime.execArgv(),
                path.join(import.meta.dirname, "fixture/external-adapter.ts"),
                `pending-${kind}`,
                member,
              ],
            },
          ]),
        ),
      )
      await using project = await tmpdir({
        git: true,
        config: {
          model: "alibaba-cn/qwen-plus",
          small_model: "alibaba-cn/qwen-plus",
          enabled_providers: ["alibaba-cn"],
          provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: model.url } } },
          permission: { edit: "ask" },
          memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
          lsp: false,
        },
      })
      const app = Server.App()
      const request = async (url: string, body?: unknown) =>
        app.request(
          `${url}?directory=${encodeURIComponent(project.path)}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
        )
      const created = await (
        await request("/collaboration", {
          leader: { name: "Leader" },
          seats: ["a", "b"].map((member) => ({
            name: `Member${member}`,
            product: `product-${member}`,
            role: "Developer",
            duty: `Work on ${member}`,
          })),
        })
      ).json()
      const id: string = created.sessionID
      const completed = request(`/session/${id}/message`, {
        parts: [{ type: "text", text: "Ask both members in parallel" }],
        permissionMode: "ask",
      }).then((response) => response.json())
      completed.catch(() => undefined)
      try {
        const pending = async () =>
          ((await (await request(`/${kind}`)).json()) as (PermissionRequest | QuestionRequest)[]).filter(
            (item) => item.sessionID === id,
          )
        await expect.poll(pending, { timeout: 10_000 }).toHaveLength(2)
        const both = await pending()
        const messages = (await (await request(`/session/${id}/message`)).json()) as { parts: Part[] }[]
        const parts = messages.flatMap((message) => message.parts)
        const first = both.find((item) =>
          parts.some(
            (part) => part.type === "tool" && part.callID === item.tool?.callID && part.state.input.seat === "Membera",
          ),
        )!
        const second = both.find((item) => item.id !== first.id)!
        expect(first.tool?.callID).toBeDefined()
        expect(second.tool?.callID).toBeDefined()
        const disabled = await request("/agent-connection/product", {
          type: "enabled",
          id: "product-a",
          enabled: false,
        })
        expect(disabled.status).toBe(200)
        await expect.poll(pending).toEqual([second])
        expect(
          (
            await request(
              `/${kind}/${second.id}/reply`,
              kind === "permission" ? { reply: "once" } : { answers: [["Proceed"]] },
            )
          ).status,
        ).toBe(200)
        await completed
        const group = (await (await request(`/collaboration/${id}`)).json()) as CollaborationGroup
        const original = (created.group as CollaborationGroup).seats.find((seat) => seat.product === "product-a")!
        expect(group.seats.find((seat) => seat.id === original.id)).toMatchObject({
          id: original.id,
          product: "product-a",
          role: "Developer",
          duty: "Work on a",
          availability: { state: "offline" },
        })
        expect(group.results).toEqual([
          expect.objectContaining({
            name: "Memberb",
            text: kind === "permission" ? "Permission allowed" : "Question answered: Proceed",
          }),
        ])
        const todos = (await (await request(`/session/${id}/todo`)).json()) as Todo[]
        expect(todos.find((todo) => todo.content.includes("Membera"))?.status).toBe("pending")
        expect(todos.find((todo) => todo.content.includes("Memberb"))?.status).toBe("completed")
        expect((await (await request(`/session/${id}`)).json()).targetBlock).toBeUndefined()
        expect(await pending()).toEqual([])
      } finally {
        await request(`/session/${id}/abort`, {})
        await completed.catch(() => undefined)
      }
    } finally {
      await model.close()
    }
  },
)
