import { expect, test } from "vitest"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test.each(["zh-CN", "en-US"] as const)(
  "starting a cleared plan reports its typed %s reason before any model request",
  async (locale) => {
    const model = await fakeModel(() => ({ text: "MUST NOT RUN" }))
    const previous = process.env.MERAKCODE_LOCALE
    process.env.MERAKCODE_LOCALE = locale
    try {
      await using tmp = await tmpdir({
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
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Cleared plan" })
          await SessionPlan.save({ sessionID: session.id, source: "human", content: "# A", expectedRevision: 0 })
          await SessionPlan.save({ sessionID: session.id, source: "human", content: "", expectedRevision: 1 })
          const result = await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] })
          expect(result.info.role === "assistant" && result.info.error).toMatchObject({
            name: "PlanConflictError",
            code: "MRK-5009",
            data: { message: expect.stringMatching(locale === "zh-CN" ? /先保存计划/ : /Save a plan/) },
          })
          expect(model.turns).toHaveLength(0)
          expect((await SessionPlan.get(session.id)).execution).toBeUndefined()
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
      if (previous === undefined) delete process.env.MERAKCODE_LOCALE
      else process.env.MERAKCODE_LOCALE = previous
    }
  },
  30000,
)

test("plan startup counts the final structured schema before saving an execution snapshot", async () => {
  const model = await fakeModel(() => ({ text: "MUST NOT RUN" }))
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "fixture/model",
        small_model: "fixture/model",
        enabled_providers: ["fixture"],
        provider: {
          fixture: {
            name: "Fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fake", baseURL: model.url },
            models: { model: { name: "Fixture", tool_call: true, limit: { context: 26000, output: 1000 } } },
          },
        },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Capacity fixture" })
        await SessionPlan.save({
          sessionID: session.id,
          content: "x".repeat(24000),
          expectedRevision: 0,
          source: "human",
        })
        const result = await Loop.prompt({
          sessionID: session.id,
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { data: { type: "string", description: "z".repeat(120000) } } },
            retryCount: 0,
          },
          parts: [{ type: "text", text: "开始执行" }],
        })
        expect(model.turns).toHaveLength(0)
        expect((await SessionPlan.get(session.id)).execution).toBeUndefined()
        expect(result.info.role === "assistant" && result.info.error).toMatchObject({ name: "PlanCapacityError" })
      },
    })
  } finally {
    await Instance.disposeAll()
    await model.close()
  }
}, 30_000)
