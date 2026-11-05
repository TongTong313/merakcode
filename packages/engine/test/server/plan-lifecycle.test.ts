import { expect, test } from "vitest"
import { Server } from "../../src/app/server/server"
import { Session } from "../../src/agent/session"
import { SessionPlan } from "../../src/agent/session/plan"
import { Loop } from "../../src/agent/loop"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { fakeModel } from "../../../sdk/js/test/fixture/model"
import { Bus } from "../../src/infra/bus"
import { Storage } from "../../src/infra/storage/storage"

test.each(["failed", "stopped", "paused", "completed"] as const)(
  "a saved %s chat rerun does not retain an older button lock",
  async (status) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Saved rerun fixture" })
        const content = "Execute the background task"
        const saved = await SessionPlan.save({ sessionID: session.id, content, expectedRevision: 0, source: "human" })
        // Persist the pre-fix record shape; assertions below use only the plan interface.
        const execution = {
          id: "b9d84493-c06e-4d59-8b2c-2e0638851042",
          content,
          startedAt: 1793846324521,
          revision: 1,
          source: "chat",
        }
        await Storage.write(["session_plan", session.id], {
          ...saved,
          status,
          execution,
          successfulButton: {
            hash: "ae4baaca72e33843438177a6a4b27bcbe180e9d25e0ab7925e96be2c0f2db1aa",
            executionID: "6e5d11e3-4de3-4e65-a4a0-a436105bdc8f",
          },
        })
        expect((await SessionPlan.get(session.id)).buttonLocked).toBe(false)
        await SessionPlan.save({ sessionID: session.id, content: "PLAN_B", expectedRevision: 1, source: "human" })
        await SessionPlan.save({ sessionID: session.id, content, expectedRevision: 2, source: "human" })
        expect((await SessionPlan.get(session.id)).buttonLocked).toBe(false)
        const started = await SessionPlan.start(session.id, "button")
        expect(started.execution?.content).toBe(content)
        if (status === "paused") expect(started.execution?.id).toBe(execution.id)
        else expect(started.execution?.id).not.toBe(execution.id)
      },
    })
  },
)

test.each(["failed", "stopped"] as const)(
  "a %s chat rerun releases a previously successful plan button",
  async (outcome) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const received: string[] = []
    const model = await fakeModel(async (turn) => {
      received.push(JSON.stringify(turn.request))
      if (turn.prompt === "开始执行") {
        entered.resolve()
        if (outcome === "failed") return { status: 400, message: "Controlled chat failure" }
        await release.promise
      }
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
          const session = await Session.create({ title: "Retry fixture" })
          const request = (action: string) =>
            Server.App().request(`/session/${session.id}/${action}?directory=${encodeURIComponent(tmp.path)}`, {
              method: "POST",
            })
          const button = async () => {
            const completed = Promise.withResolvers<void>()
            const unsubscribe = Bus.subscribe(SessionPlan.Updated, ({ properties }) => {
              if (properties.sessionID === session.id && properties.status === "completed") completed.resolve()
            })
            try {
              expect((await request("plan/start")).status).toBe(200)
              await completed.promise
              const plan = await SessionPlan.get(session.id)
              expect(plan.status).toBe("completed")
              return plan
            } finally {
              unsubscribe()
            }
          }
          await SessionPlan.save({ sessionID: session.id, content: "PLAN_A", expectedRevision: 0, source: "human" })
          const first = await button()
          expect(first.buttonLocked).toBe(true)
          const rerun = Loop.prompt({ sessionID: session.id, parts: [{ type: "text", text: "开始执行" }] }).then(
            (result) => result,
            (error: unknown) => error,
          )
          try {
            await entered.promise
            if (outcome === "stopped") expect((await request("abort")).status).toBe(200)
            const result = await rerun
            if (outcome === "stopped") expect(result).toMatchObject({ name: "MessageAbortedError" })
            const unsuccessful = await SessionPlan.get(session.id)
            expect(unsuccessful.status).toBe(outcome)
            expect(unsuccessful.execution?.id).not.toBe(first.execution?.id)
            expect(unsuccessful.buttonLocked).toBe(false)
            const retried = await button()
            expect(retried.execution).toMatchObject({ source: "button", content: "PLAN_A" })
            expect(retried.execution?.id).not.toBe(unsuccessful.execution?.id)
            expect(retried.buttonLocked).toBe(true)
            expect(received).toHaveLength(3)
            expect(received.every((input) => input.includes("PLAN_A"))).toBe(true)
          } finally {
            release.resolve()
            await Loop.cancelTree(session.id)
            await rerun
          }
        },
      })
    } finally {
      release.resolve()
      await Instance.disposeAll()
      await model.close()
    }
  },
  30_000,
)

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
          await expect
            .poll(async () => (await SessionPlan.get(session.id)).status, { timeout: 10000 })
            .toBe("completed")
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
