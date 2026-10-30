import { SessionOperations } from "@merakcode/engine/app/session"
import { afterEach, describe, expect, test, type Mock, vi } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Message } from "@merakcode/engine/agent/session/message"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Identifier } from "@merakcode/util/id"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "@merakcode/engine/agent/model/credentials"

/**
 * Message.metadata write paths.
 *
 * Like test/permission/plugin-ask.test.ts, spyOn(Plugin, "trigger") sits on the real seam between the plugin loader
 * and the code under test. Session/Message storage is not mocked: persistence, events and field merging run real
 * code, and only the plugin's hook answer is controlled.
 */

let spy: Mock<typeof Plugin.trigger> | undefined
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

describe("chat.message hook writes UserMessage.metadata", () => {
  test("metadata written by a plugin in chat.message is persisted with Loop.prompt", async () => {
    spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, input: unknown, output: unknown) => {
      if (name === "chat.message") {
        ;(output as { message: Message.UserInfo }).message.metadata = { tenant: "acme" }
      }
      return output
    }) as typeof Plugin.trigger)

    await using tmp = await tmpdir({ git: true, config: { model: "openai/gpt-5.2" } })
    await Auth.set("openai", { type: "api", key: "test-openai-key" })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const msg = await Loop.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (msg.info.role !== "user") throw new Error("expected user message")
          expect(msg.info.metadata).toEqual({ tenant: "acme" })

          // Stored on disk too, not just on the in-memory reference.
          const stored = await Session.messages({ sessionID: session.id })
          const storedUser = stored.find((m) => m.info.id === msg.info.id)
          expect(storedUser?.info.metadata).toEqual({ tenant: "acme" })
          await SessionOperations.remove(session.id)
        },
      })
    } finally {
      await Auth.remove("openai")
    }
  })

  test("UserMessage.metadata is absent without plugins", async () => {
    await using tmp = await tmpdir({ git: true, config: { model: "openai/gpt-5.2" } })
    await Auth.set("openai", { type: "api", key: "test-openai-key" })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const msg = await Loop.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (msg.info.role !== "user") throw new Error("expected user message")
          expect(msg.info.metadata).toBeUndefined()
          await SessionOperations.remove(session.id)
        },
      })
    } finally {
      await Auth.remove("openai")
    }
  })
})

describe("AssistantMessage.metadata survives message finalization", () => {
  // Keep this test: it guards against finalization clearing the assistant's metadata.
  test("AssistantMessage.metadata is kept as is without plugins", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id

        const user = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })

        const assistantInfo: Message.AssistantInfo = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: user.id,
          time: { created: Date.now() },
          metadata: { existing: true },
        }
        await Session.updateInfo(assistantInfo)

        const model = {
          id: "gpt-4",
          providerID: "openai",
          modelID: "gpt-4",
          api: { id: "gpt-4" },
        } as unknown as Provider.Model

        const proc = SessionProcessor.create({
          assistantInfo,
          sessionID,
          model,
          abort: new AbortController().signal,
        })
        const agent = await Agent.get("build")
        await proc.process({
          user: user as Message.UserInfo,
          agent: agent!,
          abort: new AbortController().signal,
          sessionID,
          system: [],
          messages: [],
          tools: {},
          model,
        })

        expect(assistantInfo.metadata).toEqual({ existing: true })
      },
    })
  })
})
