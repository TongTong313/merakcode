import { test, expect, vi } from "vitest"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { SessionMode } from "@merakcode/engine/agent/permission/mode"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { PlanEnterTool, PlanExitTool, PlanEditTool } from "@merakcode/engine/agent/tools/plan"
import { Question } from "@merakcode/engine/agent/session/question/index"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { Filesystem } from "@merakcode/util/filesystem"

// Plan mode is the read-only mode: plan_enter switches the session to read-only, plan_exit restores the previous
// mode, and the agent stays the same

async function waitForPendingQuestion() {
  for (let i = 0; i < 100; i++) {
    const pending = await Question.list()
    if (pending.length > 0) return pending
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("expected Question.list to contain a pending request")
}

function minimalCtx(sessionID: string, sessionMode: SessionMode.Value, abort = new AbortController()): Tool.Context {
  return {
    sessionID,
    messageID: "msg_test",
    callID: "call_test",
    agent: "build",
    sessionMode,
    kind: sessionMode,
    abort: abort.signal,
    messages: [],
    ruleset: [],
    metadata: async () => {},
    ask: async () => {},
  }
}

async function seedUser(sessionID: string, sessionMode: SessionMode.Value) {
  return Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    sessionMode,
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
}

async function latestUser(sessionID: string) {
  for await (const m of Message.stream(sessionID)) if (m.info.role === "user") return m.info as Message.UserInfo
  return undefined
}

test("plan edits preserve replacement text literally", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await session("plan")
      await SessionPlan.save({ sessionID: current.id, source: "agent", content: "marker", expectedRevision: 0 })
      const replacement = "keep literal $& $$ $` $'"
      await (
        await PlanEditTool.init()
      ).execute({ oldString: "marker", newString: replacement }, minimalCtx(current.id, "plan"))
      expect((await SessionPlan.get(current.id)).content).toBe(replacement)
    },
  })
})

async function countUsers(sessionID: string) {
  let userCount = 0
  for await (const m of Message.stream(sessionID)) {
    if (m.info.role === "user") userCount++
  }
  return userCount
}

/** Create a session with one user message per history mode, then set the current mode */
async function session(mode: SessionMode.Value, history: SessionMode.Value[] = [mode]) {
  const created = await Session.create({})
  for (const item of history) await seedUser(created.id, item)
  await Session.setMode({ sessionID: created.id, sessionMode: mode })
  return created
}

test("PlanEnterTool description covers revising an existing plan and entering plan mode", async () => {
  const enter = await PlanEnterTool.init()
  const desc = enter.description.toLowerCase()
  expect(desc).toMatch(/revis|modify|existing plan|改.*方案/)
  expect(desc).toMatch(/plan mode|read-only/)
  // Only the official merakcode/plans applies; arbitrary project plans/*.md must not trigger plan_enter
  expect(desc).toMatch(/merakcode\/plans|official session plan/)
  expect(desc).not.toMatch(/plan agent/)
})

test("PlanEnterTool on approval switches to read-only and continues the turn with a read-only message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("execute")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "execute"))
      const pending = await waitForPendingQuestion()
      expect(pending[0].questions[0].dismiss).toBe(false)
      expect(pending[0].questions[0].options.map((o) => o.label)).toEqual(["同意", "跳过"])
      await Question.reply({ requestID: pending[0].id, answers: [["同意"]] })
      const result = await running
      expect(result.metadata).toMatchObject({ switched: true, mode: "plan" })
      expect((await Session.get(s.id)).sessionMode).toBe("plan")
      expect(await latestUser(s.id)).toMatchObject({ agent: "build", sessionMode: "plan" })
      expect(await countUsers(s.id)).toBe(2)
    },
  })
})

test("PlanEnterTool does not switch or ask when already in plan mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("plan")
      const enter = await PlanEnterTool.init()
      const result = await enter.execute({}, minimalCtx(s.id, "plan"))
      expect(result.metadata).toMatchObject({ switched: false })
      expect(await Question.list()).toEqual([])
      expect(await countUsers(s.id)).toBe(1)
    },
  })
})

// The default fixture sets no locale, so the plan tool falls back to Chinese labels
test("PlanEnterTool on Skip does not throw, switch modes or write a message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("execute")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "execute"))
      const pending = await waitForPendingQuestion()
      await Question.reply({ requestID: pending[0].id, answers: [["跳过"]] })
      const result = await running
      expect(result.title).toBe("Plan mode skipped")
      expect(result.output).toContain("did NOT terminate")
      expect((await Session.get(s.id)).sessionMode).toBe("execute")
      expect(await countUsers(s.id)).toBe(1)
    },
  })
})

test("PlanEnterTool confirmation cannot be dismissed but can still be skipped", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("execute")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "execute"))
      const pending = await waitForPendingQuestion()
      await expect(Question.reject(pending[0].id)).rejects.toBeInstanceOf(Question.NotDismissibleError)
      expect((await Question.list()).map((item) => item.id)).toContain(pending[0].id)
      await Question.reply({ requestID: pending[0].id, answers: [["跳过"]] })
      expect((await running).title).toBe("Plan mode skipped")
    },
  })
})

test("PlanEnterTool asks to revise an existing plan and the question expires in about 15 seconds", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("execute")
      await Filesystem.write(Session.plan(s), "# existing plan\n")
      const before = Date.now()
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "execute"))
      const pending = await waitForPendingQuestion()
      const remaining = pending[0].expiresAt! - before
      expect(remaining).toBeGreaterThanOrEqual(10_000)
      expect(remaining).toBeLessThanOrEqual(20_000)
      expect(pending[0].questions[0].header).toMatch(/切回|Return to Plan/i)
      expect(pending[0].questions[0].question).toMatch(/修改|revise/i)
      await Question.reply({ requestID: pending[0].id, answers: [["跳过"]] })
      expect((await running).title).toBe("Plan mode skipped")
    },
  })
})

test("PlanEnterTool waits exactly 15 seconds then keeps the mode and writes no message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("execute")
      const enter = await PlanEnterTool.init()
      let asked: { request: Question.Request; time: number } | undefined
      const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
        asked = { request: event.properties, time: Date.now() }
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        const running = enter.execute({}, minimalCtx(s.id, "execute"))
        await vi.waitFor(() => expect(asked).toBeDefined())
        if (!asked) throw new Error("Question was not published")
        expect(asked.request.expiresAt! - asked.time).toBe(15000)
        await vi.advanceTimersByTimeAsync(asked.request.expiresAt! - Date.now() - 1)
        expect((await Question.list()).map((question) => question.id)).toContain(asked.request.id)
        await vi.advanceTimersByTimeAsync(1)
        expect((await running).title).toBe("Plan mode skipped")
        expect(await Question.list()).toEqual([])
        expect((await Session.get(s.id)).sessionMode).toBe("execute")
        expect(await countUsers(s.id)).toBe(1)
      } finally {
        unsubscribe()
        vi.useRealTimers()
      }
    },
  })
})

test("PlanEnterTool uses English Yes/Skip labels when locale is en-US", async () => {
  await using tmp = await tmpdir({ git: true, config: { locale: "en-US" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("execute")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "execute"))
      const pending = await waitForPendingQuestion()
      expect(pending[0].questions[0].options.map((o) => o.label)).toEqual(["Yes", "Skip"])
      await Question.reply({ requestID: pending[0].id, answers: [["Skip"]] })
      expect((await running).title).toBe("Plan mode skipped")
    },
  })
})

test("PlanExitTool ends planning with a persistent review and no timed question", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await session("plan")
      await SessionPlan.save({
        sessionID: current.id,
        content: "Implement the requested change",
        source: "human",
        expectedRevision: 0,
      })
      const result = await (await PlanExitTool.init()).execute({}, minimalCtx(current.id, "plan"))
      expect(result.stop).toBe(true)
      expect((await SessionPlan.get(current.id)).status).toBe("review")
      expect((await Session.get(current.id)).sessionMode).toBe("plan")
      expect(await Question.list()).toEqual([])
    },
  })
})

test.each([
  { locale: "zh-CN" as const, message: "请先编写计划，再提交审核。" },
  { locale: "en-US" as const, message: "Write the plan before submitting it for review." },
])("PlanExitTool explains an empty plan in $locale", async ({ locale, message }) => {
  await using tmp = await tmpdir({ git: true, config: { locale } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await session("plan")
      await expect((await PlanExitTool.init()).execute({}, minimalCtx(current.id, "plan"))).rejects.toMatchObject({
        name: "PlanConflictError",
        data: { message },
      })
    },
  })
})
