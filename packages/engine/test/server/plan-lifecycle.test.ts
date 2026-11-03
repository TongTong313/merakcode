import { expect, test } from "vitest"
import { Server } from "../../src/app/server/server"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { Bus } from "../../src/infra/bus"

test.each(["ask", "autoApprove", "fullTakeover"] as const)(
  "button and chat share snapshots without changing %s",
  async (permissionLevel) => {
    const received: string[] = []
    const model = await fakeModel((turn) => {
      received.push(JSON.stringify(turn.request))
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
          const session = await Session.create({ title: "Lifecycle fixture" })
          const completed: SessionPlan.Info[] = []
          Bus.subscribe(SessionPlan.Updated, (event) => {
            if (event.properties.status === "completed") completed.push(event.properties)
          })
          await selectPermissionLevel({ sessionID: session.id, permissionLevel })
          const save = (content: string) =>
            SessionPlan.get(session.id).then((plan) =>
              SessionPlan.save({ sessionID: session.id, content, expectedRevision: plan.revision, source: "human" }),
            )
          const button = () =>
            Server.App().request(`/session/${session.id}/plan/start?directory=${encodeURIComponent(tmp.path)}`, {
              method: "POST",
            })
          await save("# A\nPerform the approved work.")
          expect((await button()).status).toBe(200)
          await expect.poll(async () => (await SessionPlan.get(session.id)).status).toBe("completed")
          const first = await SessionPlan.get(session.id)
          expect(first.execution).toMatchObject({ source: "button", content: "# A\nPerform the approved work." })
          expect(first.buttonLocked).toBe(true)
          expect(completed[0]?.buttonLocked).toBe(true)
          const candidates: SessionPlan.Info[] = []
          const unsubscribe = Bus.subscribe(SessionPlan.Updated, (event) => {
            if (event.properties.sessionID === session.id && event.properties.candidate)
              candidates.push(event.properties)
          })
          try {
            const response = await Server.App().request(
              `/session/${session.id}/plan/candidate?directory=${encodeURIComponent(tmp.path)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: "# Candidate", expectedRevision: first.revision }),
              },
            )
            expect(response.status).toBe(200)
            await expect.poll(() => candidates.length).toBe(1)
            expect(candidates[0]?.buttonLocked).toBe(true)
          } finally {
            unsubscribe()
          }
          await save("# B")
          expect((await SessionPlan.get(session.id)).buttonLocked).toBe(false)
          await save("# A\r\nPerform the approved work.")
          expect((await SessionPlan.get(session.id)).buttonLocked).toBe(true)
          expect((await button()).status).toBe(200)
          expect((await SessionPlan.get(session.id)).execution?.id).toBe(first.execution?.id)
          await Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "按原计划再做一遍" }] })
          const rerun = await SessionPlan.get(session.id)
          expect(rerun.execution).toMatchObject({ source: "chat", content: "# A\r\nPerform the approved work." })
          expect(rerun.execution?.id).not.toBe(first.execution?.id)
          expect(received).toHaveLength(2)
          expect(received.every((input) => input.includes("Perform the approved work."))).toBe(true)
          expect((await Session.get(session.id)).permissionLevel).toBe(permissionLevel)
        },
      })
    } finally {
      await Instance.disposeAll()
      await model.close()
    }
  },
  30_000,
)
