import { expect, test } from "vitest"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Server } from "../../src/app/server/server"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test("three completed unrelated turns release a long plan and passive page reads do not reset the counter", async () => {
  const requests: string[] = []
  const model = await fakeModel((turn) => {
    requests.push(JSON.stringify(turn.request))
    return { text: "DONE" }
  })
  try {
    await using tmp = await tmpdir({
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
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Context fixture" })
        const content = "PLAN_FULL_BODY_" + "x".repeat(9000) + "_PLAN_END"
        await SessionPlan.save({ sessionID: session.id, source: "human", content, expectedRevision: 0 })
        const send = (text: string) => Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text }] })
        for (const text of ["解释 TypeScript", "说明 Node.js", "比较两个数字"]) await send(text)
        await Server.App().request(`/session/${session.id}/plan?directory=${encodeURIComponent(tmp.path)}`)
        await send("继续普通聊天")
        expect(requests.slice(0, 3).every((request) => request.includes(content))).toBe(true)
        expect(requests[3]!.includes(content)).toBe(false)
        expect(requests[3]).toContain("plan_read_chunk")
        await send("解释一下计划的第二步")
        expect(requests[4]!.includes(content)).toBe(true)
        expect(
          JSON.parse(requests[4]!)
            .messages.filter((message: { role: string }) => message.role === "system")
            .every((message: { content: string }) => !message.content.includes(content)),
        ).toBe(true)
      },
    })
  } finally {
    await Instance.disposeAll()
    await model.close()
  }
}, 30_000)
