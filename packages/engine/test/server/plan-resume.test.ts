import { expect, test } from "vitest"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { BashJobStore } from "../../src/agent/tools/bash-background"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"

test("a smaller model pauses work and a larger model resumes the same execution snapshot after human edits", async () => {
  const received: string[] = []
  const model = await fakeModel((turn) => {
    received.push(JSON.stringify(turn.request))
    if (turn.prompt === "开始执行" && turn.results.length === 0)
      return {
        tool: "bash_background",
        args: { command: `node -e "setInterval(()=>{},1000)"`, description: "Keep execution active" },
      }
    return { text: "DONE" }
  })
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
              small: { name: "Small", tool_call: true, limit: { context: 30000, output: 1000 } },
            },
          },
        },
        agent: { build: { deferTools: [] } },
        memory: { auto_extract: false, auto_recall: false, auto_dream: false, session_memory: false },
        lsp: false,
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Resume fixture" })
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
        const content = "SNAPSHOT_A_" + "a".repeat(104000) + "_END_A"
        await SessionPlan.save({ sessionID: session.id, source: "human", content, expectedRevision: 0 })
        try {
          await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] })
          const started = await SessionPlan.get(session.id)
          expect(started.status).toBe("executing")
          await SessionPlan.save({
            sessionID: session.id,
            source: "human",
            content: "LATEST_EDITABLE_B",
            expectedRevision: 1,
          })
          const before = received.length
          await Loop.prompt({
            sessionID: session.id,
            model: { providerID: "fixture", modelID: "small" },
            parts: [{ type: "text", text: "继续执行当前任务" }],
          })
          expect(received).toHaveLength(before)
          expect((await SessionPlan.get(session.id)).status).toBe("paused")
          await Loop.prompt({
            sessionID: session.id,
            model: { providerID: "fixture", modelID: "large" },
            parts: [{ type: "text", text: "继续执行当前任务" }],
          })
          const resumed = await SessionPlan.get(session.id)
          expect(resumed.execution?.id).toBe(started.execution?.id)
          expect(resumed.execution?.content).toBe(content)
          expect(received.at(-1)?.includes(content)).toBe(true)
          expect(received.at(-1)?.includes("LATEST_EDITABLE_B")).toBe(false)
        } finally {
          await BashJobStore.stopAll()
        }
      },
    })
  } finally {
    await Instance.disposeAll()
    await model.close()
  }
}, 30000)
