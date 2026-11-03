import { expect, test } from "vitest"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test("plan startup compacts eligible history and recomputes the actual request before saving its snapshot", async () => {
  const model = await fakeModel(() => ({ text: "DONE" }))
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "fixture/large",
        small_model: "fixture/large",
        enabled_providers: ["fixture"],
        provider: {
          fixture: {
            name: "Fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fake", baseURL: model.url },
            models: {
              large: { name: "Large", tool_call: true, limit: { context: 400000, output: 1000 } },
              small: { name: "Small", tool_call: true, limit: { context: 45000, output: 1000 } },
            },
          },
        },
        agent: { compaction: { model: "fixture/large" } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Compaction fixture" })
        await Loop.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "BACKGROUND_HISTORY_" + "h".repeat(240000) }],
        })
        const content = "FULL_PLAN_" + "p".repeat(24000) + "_PLAN_END"
        await SessionPlan.save({ sessionID: session.id, source: "human", content, expectedRevision: 0 })
        const result = await Loop.prompt({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "small" },
          parts: [{ type: "text", text: "开始执行" }],
        })
        expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
        const last = JSON.stringify(model.turns.at(-1)?.request)
        expect(last.includes(content)).toBe(true)
        expect(last.includes("BACKGROUND_HISTORY_")).toBe(false)
        expect((await SessionPlan.get(session.id)).execution?.content).toBe(content)
        expect(model.background.length).toBeGreaterThan(0)
      },
    })
  } finally {
    await Instance.disposeAll()
    await model.close()
  }
}, 30000)
