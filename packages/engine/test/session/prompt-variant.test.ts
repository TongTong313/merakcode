import { SessionOperations } from "@merakcode/engine/app/session"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "@merakcode/engine/agent/model/credentials"
import { parseItems } from "../../src/agent/model/catalog/model"
import * as OpenRouter from "../../src/agent/model/catalog/openrouter"
import { load, restoreCatalog, writeCatalog } from "../provider/catalog/fixture"

// OpenAI's list has no levels; they come from the public catalog, as in production.
beforeAll(async () => {
  await writeCatalog("public", parseItems((await load("openrouter")).data, OpenRouter.parse))
})
afterAll(restoreCatalog)

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    await Auth.set("openai", { type: "api", key: "test-openai-key" })

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "test-provider", modelID: "test-model" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
          expect(match.info.variant).toBe("xhigh")

          const override = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await SessionOperations.remove(session.id)
        },
      })
    } finally {
      await Auth.remove("openai")
    }
  })

  test("a prompt without a level records the model's official default", async () => {
    await Auth.set("openai", { type: "api", key: "test-openai-key" })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: { agent: { build: { model: "openai/gpt-5.2" } } },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const message = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (message.info.role !== "user") throw new Error("expected user message")
          expect(message.info.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
          expect(message.info.variant).toBe("medium")
          await SessionOperations.remove(session.id)
        },
      })
    } finally {
      await Auth.remove("openai")
    }
  })

  test("the agent's level applies only to the agent's own model", async () => {
    await Auth.set("openai", { type: "api", key: "test-openai-key" })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: { agent: { build: { model: "openai/gpt-5.2", variant: "xhigh" } } },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const other = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).not.toBe("xhigh")
          const match = await Loop.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.variant).toBe("xhigh")
          await SessionOperations.remove(session.id)
        },
      })
    } finally {
      await Auth.remove("openai")
    }
  })
})
