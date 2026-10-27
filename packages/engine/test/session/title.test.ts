import { afterEach, expect, test } from "vitest"
import type { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { SessionTitle } from "@merakcode/util/session-title"
import { tmpdir } from "../fixture/fixture"
import { configureConnections } from "../fixture/agent-connections"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

afterEach(() => Instance.disposeAll())

const reply = "External reply"

function config(url: string): Partial<Config.Info> {
  return {
    model: "alibaba-cn/qwen-plus",
    small_model: "alibaba-cn/qwen-plus",
    enabled_providers: ["alibaba-cn"],
    provider: { "alibaba-cn": { options: { apiKey: "fake", baseURL: url } } },
    memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
    lsp: false,
  }
}

function client(directory: string) {
  const app = Server.App()
  return (url: string, body?: unknown, method?: string) =>
    app.request(
      `${url}?directory=${encodeURIComponent(directory)}`,
      body
        ? { method: method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {},
    )
}

function product(id: string, command = `process.stdin.resume(); process.stdout.write('${reply}')`) {
  return { [id]: { command: process.execPath, args: ["-e", command] } }
}

type Request = ReturnType<typeof client>

async function create(request: Request, productID: string) {
  return (await request("/session", { target: { kind: "external", productID } })).json()
}

async function send(request: Request, sessionID: string, text: string) {
  return (
    await request(`/session/${sessionID}/message`, {
      parts: [{ type: "text", text }],
      permissionMode: "auto",
    })
  ).json()
}

async function title(request: Request, sessionID: string) {
  return (await (await request(`/session/${sessionID}`)).json()).title
}

test("titles a new external conversation after the first message", async () => {
  const model = await fakeModel(() => ({ text: reply }))
  try {
    await configureConnections(product("title-fixture"))
    await using project = await tmpdir({ git: true, config: config(model.url) })
    const request = client(project.path)
    const created = await create(request, "title-fixture")
    expect(SessionTitle.isDefault(created.title)).toBe(true)
    expect((await send(request, created.id, "How do I center a div?")).info.terminal).toBe("completed")
    expect(await title(request, created.id)).toBe("OK")
    expect(model.background).toHaveLength(1)
    expect(model.background[0]!.messages.some((message) => message.content.includes("How do I center a div?"))).toBe(
      true,
    )
  } finally {
    await model.close()
  }
})

test("titles an external conversation with the configured small model", async () => {
  const model = await fakeModel(() => ({ text: reply }))
  try {
    await configureConnections(product("small-model-fixture"))
    await using project = await tmpdir({
      git: true,
      config: { ...config(model.url), small_model: "alibaba-cn/qwen-flash" },
    })
    const request = client(project.path)
    const created = await create(request, "small-model-fixture")
    await send(request, created.id, "How do I center a div?")
    expect(model.background).toHaveLength(1)
    expect(model.background[0]!.model).toContain("qwen-flash")
  } finally {
    await model.close()
  }
})

test("falls back to the default provider's small model without a configured one", async () => {
  const model = await fakeModel(() => ({ text: reply }))
  try {
    await configureConnections(product("provider-small-model-fixture"))
    await using project = await tmpdir({
      git: true,
      config: { ...config(model.url), small_model: undefined },
    })
    const request = client(project.path)
    const created = await create(request, "provider-small-model-fixture")
    await send(request, created.id, "How do I center a div?")
    expect(model.background).toHaveLength(1)
    expect(model.background[0]!.model).toContain("qwen-flash")
  } finally {
    await model.close()
  }
})

test("uses the configured small model without a default model", async () => {
  const model = await fakeModel(() => ({ text: reply }))
  try {
    await configureConnections(product("small-model-only-fixture"))
    await using project = await tmpdir({
      git: true,
      config: { ...config(model.url), model: undefined, small_model: "alibaba-cn/qwen-flash" },
    })
    const request = client(project.path)
    const created = await create(request, "small-model-only-fixture")
    await send(request, created.id, "How do I center a div?")
    expect(await title(request, created.id)).toBe("OK")
    expect(model.background).toHaveLength(1)
    expect(model.background[0]!.model).toContain("qwen-flash")
  } finally {
    await model.close()
  }
})

test("keeps the default title when no MerakCode model is available", async () => {
  await configureConnections(product("no-model-fixture"))
  await using project = await tmpdir({ git: true })
  const request = client(project.path)
  const created = await create(request, "no-model-fixture")
  expect((await send(request, created.id, "How do I center a div?")).info.terminal).toBe("completed")
  const updated = await title(request, created.id)
  expect(updated).toBe(created.title)
  expect(SessionTitle.isDefault(updated)).toBe(true)
})

test("keeps a title set before the first external message", async () => {
  const model = await fakeModel(() => ({ text: reply }))
  try {
    await configureConnections(product("rename-fixture"))
    await using project = await tmpdir({ git: true, config: config(model.url) })
    const request = client(project.path)
    const created = await create(request, "rename-fixture")
    const renamed = await (await request(`/session/${created.id}`, { title: "Custom title" }, "PATCH")).json()
    expect(renamed.title).toBe("Custom title")
    await send(request, created.id, "How do I center a div?")
    expect(await title(request, created.id)).toBe("Custom title")
    expect(model.background).toHaveLength(0)
  } finally {
    await model.close()
  }
})

test("does not title later external turns", async () => {
  const model = await fakeModel(() => ({ text: reply }))
  try {
    await configureConnections(product("later-turn-fixture"))
    await using project = await tmpdir({ git: true, config: config(model.url) })
    const request = client(project.path)
    const created = await create(request, "later-turn-fixture")
    await send(request, created.id, "First message")
    expect(await title(request, created.id)).toBe("OK")
    await send(request, created.id, "Second message")
    expect(await title(request, created.id)).toBe("OK")
    expect(model.background).toHaveLength(1)
  } finally {
    await model.close()
  }
})

test("titles an external conversation even when the product fails", async () => {
  const model = await fakeModel(() => ({ text: "unused" }))
  try {
    await configureConnections(product("failing-fixture", "process.exit(0)"))
    await using project = await tmpdir({ git: true, config: config(model.url) })
    const request = client(project.path)
    const created = await create(request, "failing-fixture")
    expect((await send(request, created.id, "How do I center a div?")).info.terminal).toBe("failed")
    expect(await title(request, created.id)).toBe("OK")
  } finally {
    await model.close()
  }
})

test("titles a new native conversation after the first prompt", async () => {
  const model = await fakeModel(() => ({ text: "Hello" }))
  try {
    await using project = await tmpdir({ git: true, config: config(model.url) })
    const request = client(project.path)
    const created = await (await request("/session", {})).json()
    expect(SessionTitle.isDefault(created.title)).toBe(true)
    const reply = await send(request, created.id, "Hello there")
    expect(reply.info.role).toBe("assistant")
    expect(await title(request, created.id)).toBe("OK")
  } finally {
    await model.close()
  }
})
