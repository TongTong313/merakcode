import { expect, test } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { createMerakCode, type RunEvent } from "@merakcode/sdk"
import { startEngine } from "@merakcode/sdk/process"
import { formatTranscript } from "@merakcode/sdk/transcript"
import { engine, sandbox } from "../fixture/engine"
import { Identifier } from "@merakcode/util/id"
import { fakeModel } from "../fixture/model"

test.each(["failed", "cancelled"] as const)(
  "preserves observed steps from an external %s turn without text when MerakCode takes over",
  async (terminal) => {
    const model = await fakeModel(() => ({ text: "Continuing from the recorded history" }))
    await using isolated = await sandbox(model.url)
    const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
    try {
      const { client } = connection
      await client.agentConnection.product.change(
        {
          body: {
            type: "add",
            id: "step-history",
            product: {
              adapter: "member",
              command: process.execPath,
              args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
            },
          },
        },
        { throwOnError: true },
      )
      const created = (
        await client.session.create({ target: { kind: "external", productID: "step-history" } }, { throwOnError: true })
      ).data
      await client.session.promptAsync(
        { sessionID: created.id, parts: [{ type: "text", text: `step-without-text:${terminal}` }] },
        { throwOnError: true },
      )
      const messages = async () =>
        (await client.session.messages({ sessionID: created.id }, { throwOnError: true })).data
      await expect
        .poll(async () => (await messages()).at(-1)?.info.metadata?.externalSteps, { timeout: 10_000 })
        .toEqual([{ tool: "Write", detail: "ALREADY_EDITED_MARKER.txt" }])
      if (terminal === "cancelled") await client.session.abort({ sessionID: created.id }, { throwOnError: true })
      await expect
        .poll(
          async () => {
            const info = (await messages()).at(-1)?.info
            return info && "terminal" in info ? info.terminal : undefined
          },
          { timeout: 10_000 },
        )
        .toBe(terminal)
      expect((await messages()).at(-1)?.parts).toEqual([])
      await client.agentConnection.product.change(
        { body: { type: "enabled", id: "step-history", enabled: false } },
        { throwOnError: true },
      )
      const blocked = (await client.session.get({ sessionID: created.id }, { throwOnError: true })).data
      await client.session.takeover(
        {
          sessionID: created.id,
          decision: "accept",
          expectedTargetRevision: blocked.targetRevision!,
          blockID: blocked.targetBlock!.blockID,
        },
        { throwOnError: true },
      )
      await client.session.prompt(
        { sessionID: created.id, parts: [{ type: "text", text: "Continue with the existing context" }] },
        { throwOnError: true },
      )
      const history = model.turns.find((turn) => turn.prompt === "Continue with the existing context")!.messages
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.stringContaining(
              "Observed external tool steps, not tool results:\nWrite: ALREADY_EDITED_MARKER.txt",
            ),
          }),
        ]),
      )
      expect(
        history.some((message) =>
          message.content.includes(`External turn ${terminal}; do not replay its previous actions.`),
        ),
      ).toBe(true)
      expect(history.filter((message) => message.role === "tool")).toEqual([])
    } finally {
      await connection.close()
      await model.close()
    }
  },
  120_000,
)

test("rejects a normalized client message ID after an engine restart", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const options = { cwd: isolated.project, executablePath: engine, env: isolated.env }
  let connection = await createMerakCode(options)
  try {
    await connection.client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "retry-fixture",
          product: {
            adapter: "member",
            command: process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
          },
        },
      },
      { throwOnError: true },
    )
    const created = (
      await connection.client.session.create(
        { target: { kind: "external", productID: "retry-fixture" } },
        { throwOnError: true },
      )
    ).data
    const input = {
      sessionID: created.id,
      messageID: Identifier.create("message", false, Date.now() + 60_000),
      parts: [{ type: "text" as const, text: "Perform this task once" }],
    }
    const first = (await connection.client.session.prompt(input, { throwOnError: true })).data
    expect(first.info.role === "assistant" && "terminal" in first.info && first.info.terminal).toBe("completed")
    const original = (await connection.client.session.messages({ sessionID: created.id }, { throwOnError: true })).data
    await connection.close()
    connection = await createMerakCode(options)
    const repeated = await connection.client.session.prompt(input)
    expect(repeated.response.status).toBe(400)
    expect(repeated.error).toMatchObject({ code: "MRK-4008" })
    expect((await connection.client.session.messages({ sessionID: created.id }, { throwOnError: true })).data).toEqual(
      original,
    )
  } finally {
    await connection.close()
  }
}, 120_000)

test("uses generated SDK methods for external configuration, streaming, and attributed transcript export", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  try {
    const { client } = connection
    await client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "sdk-fixture",
          product: {
            title: "SDK fixture",
            adapter: "member",
            command: process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
            model: { id: "fixture-requested" },
          },
        },
      },
      { throwOnError: true },
    )
    const created = (
      await client.session.create({ target: { kind: "external", productID: "sdk-fixture" } }, { throwOnError: true })
    ).data
    const session = await connection.session({ id: created.id })
    const events: RunEvent[] = []
    for await (const event of session.run("Hello world")) events.push(event)
    const done = events.find((event) => event.type === "done")
    expect(done?.type === "done" && done.message.execution).toMatchObject({
      kind: "external",
      productID: "sdk-fixture",
      actualModel: { id: "fixture-selected" },
    })
    const messages = await session.messages()
    expect(
      messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text),
    ).toEqual(["Hello world", "External reply: Hello world"])
    const transcript = formatTranscript(created, messages, {
      thinking: false,
      toolDetails: false,
      assistantMetadata: true,
      lang: "en",
    })
    expect(transcript).toContain("SDK fixture")
    expect(transcript).toContain("fixture-selected")
    expect(transcript).not.toContain("sdk-fixture-thread")
  } finally {
    await connection.close()
  }
}, 120_000)

test("refuses built-in model overrides loaded through raw global configuration", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  try {
    await connection.client.global.config.update(
      {
        skipDispose: "true",
        config: {
          agentConnections: {
            products: {
              claude: { command: process.execPath, model: { id: "fixture-requested" }, args: ["--model", "override"] },
            },
          },
        },
      },
      { throwOnError: true },
    )
    const products = (await connection.client.agentConnection.products({ refresh: "true" }, { throwOnError: true }))
      .data
    const product = products.find((item) => item.id === "claude")
    expect(product?.connected).toBe(false)
    expect(product?.reason).toEqual(expect.any(String))
  } finally {
    await connection.close()
  }
}, 120_000)

test("resumes the same external thread after restart while applying the latest global model", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const options = { cwd: isolated.project, executablePath: engine, env: isolated.env }
  let connection = await createMerakCode(options)
  const product = {
    title: "SDK fixture",
    adapter: "member" as const,
    command: process.execPath,
    args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
    model: { id: "fixture-requested" },
  }
  try {
    await connection.client.agentConnection.product.change(
      { body: { type: "add", id: "sdk-fixture", product } },
      { throwOnError: true },
    )
    let session = await connection.session({ target: { kind: "external", productID: "sdk-fixture" } })
    for await (const event of session.run("report external thread")) void event
    const first = (await session.messages()).find((message) => message.info.role === "assistant")!
    expect(first.info.execution).toMatchObject({ actualModel: { id: "fixture-selected" } })
    const threadText = first.parts.find((part) => part.type === "text")
    expect(threadText?.type === "text" && threadText.text).toMatch(/^Thread: sdk-fixture-thread-/)
    await connection.client.agentConnection.product.change(
      { body: { type: "update", id: "sdk-fixture", product: { ...product, model: { id: "fixture-second" } } } },
      { throwOnError: true },
    )
    await connection.close()
    connection = await createMerakCode(options)
    session = await connection.session({ id: session.id })
    for await (const event of session.run("report external thread")) void event
    const replies = (await session.messages()).filter((message) => message.info.role === "assistant")
    expect(replies).toHaveLength(2)
    expect(replies[1]!.parts.find((part) => part.type === "text")).toMatchObject({
      text: threadText?.type === "text" ? threadText.text : "",
    })
    expect(replies[1]!.info.execution).toMatchObject({
      requestedModel: { id: "fixture-second" },
      actualModel: { id: "fixture-selected-second" },
    })
  } finally {
    await connection.close()
  }
}, 120_000)

test("marks an unfinished external turn interrupted after an engine crash without replaying it", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const options = { cwd: isolated.project, executablePath: engine, env: isolated.env }
  let backend = await startEngine(options)
  let connection = await createMerakCode({ cwd: isolated.project, url: backend.url, headers: backend.headers })
  const gate = path.join(isolated.project, "crash-gate")
  try {
    await connection.client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "sdk-fixture",
          product: {
            title: "SDK fixture",
            adapter: "member",
            command: globalThis.process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
          },
        },
      },
      { throwOnError: true },
    )
    const session = await connection.session({ target: { kind: "external", productID: "sdk-fixture" } })
    const subscription = new AbortController()
    const events = session.run(`gate:${gate}`, { signal: subscription.signal })[Symbol.asyncIterator]()
    for (;;) {
      const next = await events.next()
      expect(next.done).toBe(false)
      if (next.value?.type === "done") throw new Error("The turn completed before the crash")
      if (next.value?.type === "part" && next.value.part.type === "text" && next.value.part.text === "Hello ") break
    }
    const disconnected = events.next().catch(() => undefined)
    globalThis.process.kill(backend.pid)
    await backend.exited
    subscription.abort()
    await disconnected
    await events.return?.()
    await connection.close()
    backend = await startEngine(options)
    connection = await createMerakCode({ cwd: isolated.project, url: backend.url, headers: backend.headers })
    await connection.client.session.get({ sessionID: session.id }, { throwOnError: true })
    const messages = (await connection.client.session.messages({ sessionID: session.id }, { throwOnError: true })).data
    expect(messages).toHaveLength(2)
    const reply = messages.find((message) => message.info.role === "assistant")
    expect(reply?.info.execution?.kind).toBe("external")
    expect(reply && "terminal" in reply.info && reply.info.terminal).toBe("interrupted")
    expect(reply?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Hello "])
  } finally {
    await fs.writeFile(gate, "go")
    await connection.close()
    await backend.close()
  }
}, 120_000)

test("imports external history as read-only without copying the external resume binding", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  try {
    const { client } = connection
    await client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "sdk-fixture",
          product: {
            title: "SDK fixture",
            adapter: "member",
            command: process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
          },
        },
      },
      { throwOnError: true },
    )
    const session = await connection.session({ target: { kind: "external", productID: "sdk-fixture" } })
    for await (const event of session.run("Keep this history")) void event
    const exported = (await client.session.exportFull({ sessionID: session.id }, { throwOnError: true })).data
    expect(JSON.stringify(exported)).not.toContain("sdk-fixture-thread")
    const imported = (await client.session.importFull(exported, { throwOnError: true })).data.info
    expect(imported.id).toEqual(expect.any(String))
    expect(imported.id).not.toBe(session.id)
    expect(imported.readOnlyReason).toBe("imported-external-history")
    expect(imported.targetBlock).toBeUndefined()
    const messages = (await client.session.messages({ sessionID: imported.id }, { throwOnError: true })).data
    expect(messages.find((message) => message.info.role === "assistant")?.info.execution).toMatchObject({
      kind: "external",
      productID: "sdk-fixture",
    })
    const send = await client.session.promptAsync({
      sessionID: imported.id,
      parts: [{ type: "text", text: "Must not resume" }],
    })
    expect(send.response.status).toBe(400)
  } finally {
    await connection.close()
  }
}, 120_000)

test("delivers external text through the SDK before the product finishes its turn", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  const gate = path.join(isolated.project, "finish")
  try {
    await connection.client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "sdk-fixture",
          product: {
            title: "SDK fixture",
            adapter: "member",
            command: process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
          },
        },
      },
      { throwOnError: true },
    )
    const session = await connection.session({ target: { kind: "external", productID: "sdk-fixture" } })
    const events = session.run(`gate:${gate}`)[Symbol.asyncIterator]()
    for (;;) {
      const next = await events.next()
      expect(next.done).toBe(false)
      if (next.value?.type === "done") throw new Error("The turn finished before text was streamed")
      if (next.value?.type === "part" && next.value.part.type === "text" && next.value.part.text === "Hello ") break
    }
    await fs.writeFile(gate, "go")
    while (!(await events.next()).done) {
      /* Drain the completed turn. */
    }
    const messages = await session.messages()
    const reply = messages.find((message) => message.info.role === "assistant")
    expect(reply?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Hello world"])
  } finally {
    await fs.writeFile(gate, "go")
    await connection.close()
  }
}, 120_000)

test("takes over only the conversation explicitly accepted through the SDK", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  const connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  try {
    const { client } = connection
    await client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "sdk-fixture",
          product: {
            title: "SDK fixture",
            adapter: "member",
            command: process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
          },
        },
      },
      { throwOnError: true },
    )
    const target = { kind: "external" as const, productID: "sdk-fixture" }
    const first = (await client.session.create({ target }, { throwOnError: true })).data
    const second = (await client.session.create({ target }, { throwOnError: true })).data
    await client.agentConnection.product.change(
      { body: { type: "enabled", id: "sdk-fixture", enabled: false } },
      { throwOnError: true },
    )
    const blocked = (await client.session.get({ sessionID: first.id }, { throwOnError: true })).data
    const decision = {
      sessionID: first.id,
      decision: "accept" as const,
      expectedTargetRevision: blocked.targetRevision!,
      blockID: blocked.targetBlock!.blockID,
    }
    const accepted = (await client.session.takeover(decision, { throwOnError: true })).data
    expect(accepted.id).toBe(first.id)
    expect(accepted.target).toEqual({ kind: "merak" })
    expect(accepted.targetBlock).toBeUndefined()
    expect((await client.session.takeover(decision, { throwOnError: true })).data.takeover).toEqual(accepted.takeover)
    const untouched = (await client.session.get({ sessionID: second.id }, { throwOnError: true })).data
    expect(untouched.target).toEqual(target)
    expect(untouched.targetBlock?.decision).toBe("pending")
    expect((await client.session.messages({ sessionID: first.id }, { throwOnError: true })).data).toEqual([])
  } finally {
    await connection.close()
  }
}, 120_000)

test("persists an explicitly declined takeover across an engine restart", async () => {
  await using isolated = await sandbox("http://127.0.0.1:1", { enabled_providers: [] })
  let connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
  try {
    let client = connection.client
    await client.agentConnection.product.change(
      {
        body: {
          type: "add",
          id: "sdk-fixture",
          product: {
            title: "SDK fixture",
            adapter: "member",
            command: process.execPath,
            args: [...engine.slice(1, -1), path.join(import.meta.dirname, "../fixture/external-adapter.ts")],
          },
        },
      },
      { throwOnError: true },
    )
    const created = (
      await client.session.create({ target: { kind: "external", productID: "sdk-fixture" } }, { throwOnError: true })
    ).data
    await client.agentConnection.product.change(
      { body: { type: "enabled", id: "sdk-fixture", enabled: false } },
      { throwOnError: true },
    )
    const blocked = (await client.session.get({ sessionID: created.id }, { throwOnError: true })).data
    expect(blocked.targetBlock?.decision).toBe("pending")
    const sent = await client.session.promptAsync({
      sessionID: created.id,
      parts: [{ type: "text", text: "Must not run" }],
    })
    expect(sent.response.status).toBe(409)
    expect((await client.session.messages({ sessionID: created.id }, { throwOnError: true })).data).toEqual([])
    await client.session.takeover(
      {
        sessionID: created.id,
        decision: "decline",
        expectedTargetRevision: blocked.targetRevision!,
        blockID: blocked.targetBlock!.blockID,
      },
      { throwOnError: true },
    )
    await connection.close()
    connection = await createMerakCode({ cwd: isolated.project, executablePath: engine, env: isolated.env })
    client = connection.client
    const reopened = (await client.session.get({ sessionID: created.id }, { throwOnError: true })).data
    expect(reopened.targetBlock).toMatchObject({ decision: "declined", blockID: blocked.targetBlock!.blockID })
    expect(reopened.target).toEqual({ kind: "external", productID: "sdk-fixture" })
  } finally {
    await connection.close()
  }
}, 120_000)
