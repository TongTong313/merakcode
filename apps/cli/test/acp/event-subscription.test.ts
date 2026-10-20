import { describe, expect, test } from "vitest"
import { ACP } from "../../src/cli/acp/agent"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event } from "@merakcode/sdk/client"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type RequestPermissionParams = Parameters<AgentSideConnection["requestPermission"]>[0]
type RequestPermissionResult = Awaited<ReturnType<AgentSideConnection["requestPermission"]>>

type GlobalEventEnvelope = {
  directory?: string
  payload?: Event
}

type EventController = {
  push: (event: GlobalEventEnvelope) => void
  close: () => void
}

function createEventStream() {
  const queue: GlobalEventEnvelope[] = []
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []
  const state = { closed: false }

  const push = (event: GlobalEventEnvelope) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    queue.push(event)
  }

  const close = () => {
    state.closed = true
    for (const waiter of waiters.splice(0)) {
      waiter(undefined)
    }
  }

  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (state.closed) return
      const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => {
        waiters.push(resolve)
        if (!signal) return
        signal.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return
      yield value
    }
  }

  return { controller: { push, close } satisfies EventController, stream }
}

function createFakeAgent() {
  const updates = new Map<string, string[]>()
  const chunks = new Map<string, string>()
  const record = (sessionId: string, type: string) => {
    const list = updates.get(sessionId) ?? []
    list.push(type)
    updates.set(sessionId, list)
  }

  const connection = {
    async sessionUpdate(params: SessionUpdateParams) {
      const update = params.update
      const type = update?.sessionUpdate ?? "unknown"
      record(params.sessionId, type)
      if (update?.sessionUpdate === "agent_message_chunk") {
        const content = update.content
        if (content?.type !== "text") return
        if (typeof content.text !== "string") return
        chunks.set(params.sessionId, (chunks.get(params.sessionId) ?? "") + content.text)
      }
    },
    async requestPermission(_params: RequestPermissionParams): Promise<RequestPermissionResult> {
      return { outcome: { outcome: "selected", optionId: "once" } } as RequestPermissionResult
    },
  } as unknown as AgentSideConnection

  const { controller, stream } = createEventStream()
  const calls = {
    eventSubscribe: 0,
    sessionCreate: 0,
  }

  const sdk = {
    global: {
      event: async (opts?: { signal?: AbortSignal }) => {
        calls.eventSubscribe++
        return { stream: stream(opts?.signal) }
      },
    },
    instance: {
      dispose: async () => {},
    },
    session: {
      create: async (_params?: any) => {
        calls.sessionCreate++
        return {
          data: {
            id: `ses_${calls.sessionCreate}`,
            time: { created: new Date().toISOString() },
          },
        }
      },
      get: async (_params?: any) => {
        return {
          data: {
            id: "ses_1",
            time: { created: new Date().toISOString() },
          },
        }
      },
      messages: async () => {
        return { data: [] }
      },
      message: async () => {
        return {
          data: {
            info: {
              role: "assistant",
            },
          },
        }
      },
    },
    permission: {
      respond: async () => {
        return { data: true }
      },
    },
    config: {
      providers: async () => {
        return {
          data: {
            providers: [
              {
                id: "test-provider",
                name: "Test Provider",
                models: {
                  "test-model": { id: "test-model", name: "Test Model" },
                },
              },
            ],
          },
        }
      },
    },
    app: {
      agents: async () => {
        return {
          data: [
            {
              name: "build",
              description: "build",
              mode: "agent",
            },
          ],
        }
      },
    },
    command: {
      list: async () => {
        return { data: [] }
      },
    },
    mcp: {
      add: async () => {
        return { data: true }
      },
    },
  } as any

  const agent = new ACP.Agent(connection, {
    sdk,
    defaultModel: { providerID: "test-provider", modelID: "test-model" },
  } as any)

  const stop = () => {
    controller.close()
    ;(agent as any).eventAbort.abort()
  }

  return { agent, controller, calls, updates, chunks, stop, sdk, connection }
}

describe("acp.agent event subscription", () => {
  test("routes message.part.updated by the event sessionID (no cross-session pollution)", async () => {
    const { agent, controller, updates, stop } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
    const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    controller.push({
      directory: cwd,
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: sessionB,
            messageID: "msg_1",
            type: "text",
            synthetic: false,
          },
          delta: "hello",
        },
      },
    } as any)

    await new Promise((r) => setTimeout(r, 10))

    expect((updates.get(sessionA) ?? []).includes("agent_message_chunk")).toBe(false)
    expect((updates.get(sessionB) ?? []).includes("agent_message_chunk")).toBe(true)

    stop()
  })

  test("keeps concurrent sessions isolated when message.part.updated events are interleaved", async () => {
    const { agent, controller, chunks, stop } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
    const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    const tokenA = ["ALPHA_", "111", "_X"]
    const tokenB = ["BETA_", "222", "_Y"]

    const push = (sessionId: string, messageID: string, delta: string) => {
      controller.push({
        directory: cwd,
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: sessionId,
              messageID,
              type: "text",
              synthetic: false,
            },
            delta,
          },
        },
      } as any)
    }

    push(sessionA, "msg_a", tokenA[0])
    push(sessionB, "msg_b", tokenB[0])
    push(sessionA, "msg_a", tokenA[1])
    push(sessionB, "msg_b", tokenB[1])
    push(sessionA, "msg_a", tokenA[2])
    push(sessionB, "msg_b", tokenB[2])

    await new Promise((r) => setTimeout(r, 20))

    const a = chunks.get(sessionA) ?? ""
    const b = chunks.get(sessionB) ?? ""

    expect(a).toContain(tokenA.join(""))
    expect(b).toContain(tokenB.join(""))
    for (const part of tokenB) expect(a).not.toContain(part)
    for (const part of tokenA) expect(b).not.toContain(part)

    stop()
  })

  test("does not create additional event subscriptions on repeated loadSession()", async () => {
    const { agent, calls, stop } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"

    const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
    await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
    await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
    await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)

    expect(calls.eventSubscribe).toBe(1)

    stop()
  })

  test("permission.asked events are handled and replied", async () => {
    const permissionReplies: string[] = []
    const { agent, controller, stop, sdk } = createFakeAgent()
    sdk.permission.reply = async (params: any) => {
      permissionReplies.push(params.requestID)
      return { data: true }
    }
    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    controller.push({
      directory: cwd,
      payload: {
        type: "permission.asked",
        properties: {
          id: "perm_1",
          sessionID: sessionA,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
        },
      },
    } as any)

    await new Promise((r) => setTimeout(r, 20))

    expect(permissionReplies).toContain("perm_1")

    stop()
  })

  test("permission prompt on session A does not block message updates for session B", async () => {
    const permissionReplies: string[] = []
    let resolvePermissionA: (() => void) | undefined
    const permissionABlocking = new Promise<void>((r) => {
      resolvePermissionA = r
    })

    const { agent, controller, chunks, stop, sdk, connection } = createFakeAgent()

    // Make permission request for session A block until we release it
    const originalRequestPermission = connection.requestPermission.bind(connection)
    let permissionCalls = 0
    connection.requestPermission = async (params: RequestPermissionParams) => {
      permissionCalls++
      if (params.sessionId.endsWith("1")) {
        await permissionABlocking
      }
      return originalRequestPermission(params)
    }

    sdk.permission.reply = async (params: any) => {
      permissionReplies.push(params.requestID)
      return { data: true }
    }

    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
    const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    // Push permission.asked for session A (will block)
    controller.push({
      directory: cwd,
      payload: {
        type: "permission.asked",
        properties: {
          id: "perm_a",
          sessionID: sessionA,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
        },
      },
    } as any)

    // Give time for permission handling to start
    await new Promise((r) => setTimeout(r, 10))

    // Push message for session B while A's permission is pending
    controller.push({
      directory: cwd,
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: sessionB,
            messageID: "msg_b",
            type: "text",
            synthetic: false,
          },
          delta: "session_b_message",
        },
      },
    } as any)

    // Wait for session B's message to be processed
    await new Promise((r) => setTimeout(r, 20))

    // Session B should have received message even though A's permission is still pending
    expect(chunks.get(sessionB) ?? "").toContain("session_b_message")
    expect(permissionReplies).not.toContain("perm_a")

    // Release session A's permission
    resolvePermissionA!()
    await new Promise((r) => setTimeout(r, 20))

    // Now session A's permission should be replied
    expect(permissionReplies).toContain("perm_a")

    stop()
  })

  test("handles session.updated events", async () => {
    const { agent, controller, connection, stop } = createFakeAgent()
    const extNotifications: Array<{ method: string; params: any }> = []
    connection.extNotification = async (method: string, params: any) => {
      extNotifications.push({ method, params })
    }
    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    controller.push({
      directory: cwd,
      payload: {
        type: "session.updated",
        properties: {
          info: { id: sessionA, time: { created: Date.now(), updated: Date.now() } },
        },
      },
    } as any)

    await new Promise((r) => setTimeout(r, 20))

    expect(extNotifications.some((n) => n.method === "session.updated" && n.params.sessionId === sessionA)).toBe(true)

    stop()
  })

  test("handles session.deleted events", async () => {
    const { agent, controller, connection, stop } = createFakeAgent()
    const extNotifications: Array<{ method: string; params: any }> = []
    connection.extNotification = async (method: string, params: any) => {
      extNotifications.push({ method, params })
    }
    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    controller.push({
      directory: cwd,
      payload: {
        type: "session.deleted",
        properties: {
          info: { id: sessionA, time: { created: Date.now(), updated: Date.now() } },
        },
      },
    } as any)

    await new Promise((r) => setTimeout(r, 20))

    expect(extNotifications.some((n) => n.method === "session.deleted" && n.params.sessionId === sessionA)).toBe(true)

    stop()
  })

  test("handles session.error events", async () => {
    const { agent, controller, updates, stop } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"

    const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    controller.push({
      directory: cwd,
      payload: {
        type: "session.error",
        properties: {
          sessionID: sessionA,
          error: "Test error",
        },
      },
    } as any)

    await new Promise((r) => setTimeout(r, 20))

    expect((updates.get(sessionA) ?? []).includes("agent_message_chunk")).toBe(true)

    stop()
  })

  test("builtin command takes priority over server command with same name", async () => {
    const { agent, stop, sdk } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"

    // The server also returns a command named "compact"
    let serverCommandCalled = false
    sdk.command.list = async () => {
      return {
        data: [{ name: "compact", description: "server compact" }],
      }
    }
    // Records whether the server command runs
    sdk.session.command = async () => {
      serverCommandCalled = true
      return { data: { info: null } }
    }
    // session.summarize backs the builtin compact
    let builtinCalled = false
    sdk.session.summarize = async () => {
      builtinCalled = true
      return { data: true }
    }

    const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "/compact" }],
    } as any)

    expect(builtinCalled).toBe(true)
    expect(serverCommandCalled).toBe(false)

    stop()
  })

  test("the model is a session config option, and the next message uses the newly selected model", async () => {
    const { agent, stop, sdk } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"
    sdk.config.providers = async () => ({
      data: {
        providers: [
          {
            id: "test-provider",
            name: "Test Provider",
            models: {
              "test-model": { id: "test-model", name: "Test Model" },
              "fast-model": { id: "fast-model", name: "Fast Model", variants: { high: {} } },
            },
          },
        ],
      },
    })
    const sent: unknown[] = []
    sdk.session.prompt = async (input: { model: unknown; variant?: string }) => {
      sent.push({ model: input.model, variant: input.variant })
      return { data: { info: null } }
    }

    const created = await agent.newSession({ cwd, mcpServers: [] } as any)
    const model = created.configOptions?.find((option) => option.category === "model")
    expect(model).toMatchObject({ type: "select", currentValue: "test-provider/test-model" })
    const values = model?.type === "select" ? model.options.flatMap((o) => ("value" in o ? [o.value] : [])) : []
    expect(values).toEqual(
      expect.arrayContaining(["test-provider/test-model", "test-provider/fast-model", "test-provider/fast-model/high"]),
    )

    const changed = await agent.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: model!.id,
      value: "test-provider/fast-model/high",
    })
    expect(changed.configOptions.find((option) => option.id === model!.id)?.currentValue).toBe(
      "test-provider/fast-model/high",
    )

    await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] } as any)
    expect(sent).toEqual([{ model: { providerID: "test-provider", modelID: "fast-model" }, variant: "high" }])

    stop()
  })

  test("reopening a session resumes the model and variant of the last turn", async () => {
    const { agent, stop, sdk } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"
    sdk.config.providers = async () => ({
      data: {
        providers: [
          {
            id: "test-provider",
            name: "Test Provider",
            models: {
              "test-model": { id: "test-model", name: "Test Model" },
              "fast-model": { id: "fast-model", name: "Fast Model", variants: { high: {} } },
            },
          },
        ],
      },
    })
    sdk.session.messages = async () => ({
      data: [
        {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "user",
            agent: "build",
            model: { providerID: "test-provider", modelID: "fast-model" },
            variant: "high",
          },
          parts: [],
        },
      ],
    })

    const loaded = await agent.loadSession({ sessionId: "ses_1", cwd, mcpServers: [] } as any)
    expect(loaded.configOptions?.find((option) => option.category === "model")?.currentValue).toBe(
      "test-provider/fast-model/high",
    )

    stop()
  })

  test("/undo reverts to before the latest message the user typed, and a second /undo one further back", async () => {
    const { agent, stop, sdk } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"
    const user = (id: string, text: string, synthetic = false) => ({
      info: { id, sessionID: "ses_1", role: "user" },
      parts: [{ type: "text", text, synthetic }],
    })
    const assistant = (id: string) => ({ info: { id, sessionID: "ses_1", role: "assistant" }, parts: [] })
    const history = [
      user("msg_1", "first"),
      assistant("msg_2"),
      user("msg_3", "second"),
      assistant("msg_4"),
      user("msg_5", "summary", true),
    ]
    let revert: { messageID: string } | undefined
    sdk.session.messages = async () => ({ data: history })
    sdk.session.get = async () => ({ data: { id: "ses_1", time: { created: 0 }, revert } })
    sdk.session.revert = async (input: { messageID: string }) => {
      revert = { messageID: input.messageID }
      return { data: {} }
    }

    const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/undo" }] } as any)
    expect(revert).toEqual({ messageID: "msg_3" })
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/undo" }] } as any)
    expect(revert).toEqual({ messageID: "msg_1" })

    stop()
  })

  test("terminal is created idempotently on tool running and released on completed", async () => {
    const { agent, controller, stop, connection } = createFakeAgent()
    const cwd = "/tmp/merakcode-acp-test"

    // mock createTerminal
    const createdTerminals: string[] = []
    const releasedTerminals: string[] = []
    connection.createTerminal = (async (_params: any) => {
      const id = `term_${createdTerminals.length + 1}`
      createdTerminals.push(id)
      return {
        id,
        release: async () => {
          releasedTerminals.push(id)
        },
      }
    }) as any

    const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

    // Pushes running twice for the same callID to check idempotence
    const pushToolEvent = (status: string) => {
      controller.push({
        directory: cwd,
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID: sessionId,
              messageID: "msg_1",
              callID: "call_bash_1",
              type: "tool",
              tool: "bash",
              state: {
                status,
                input: { command: "echo hello" },
                output: status === "completed" ? "hello" : undefined,
                title: "bash",
              },
            },
            delta: null,
          },
        },
      } as any)
    }

    pushToolEvent("running")
    pushToolEvent("running")
    await new Promise((r) => setTimeout(r, 30))

    expect(createdTerminals.length).toBe(1)

    pushToolEvent("completed")
    await new Promise((r) => setTimeout(r, 20))

    expect(releasedTerminals.length).toBe(1)

    stop()
  })
})
