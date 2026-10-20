import { test, expect } from "vitest"
import { PermissionMode } from "@merakcode/engine/permission/mode"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { findReturnMode, PlanEnterTool, PlanExitTool } from "@merakcode/engine/tool/plan"
import { Question } from "@merakcode/engine/question/index"
import type { Tool } from "@merakcode/engine/tool/tool"
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

function minimalCtx(
  sessionID: string,
  permissionMode: PermissionMode.Value,
  abort = new AbortController(),
): Tool.Context {
  return {
    sessionID,
    messageID: "msg_test",
    callID: "call_test",
    agent: "build",
    permissionMode,
    kind: permissionMode,
    abort: abort.signal,
    messages: [],
    ruleset: [],
    metadata: async () => {},
    ask: async () => {},
  }
}

async function seedUser(sessionID: string, permissionMode: PermissionMode.Value) {
  return Session.updateInfo({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "build",
    permissionMode,
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
}

async function latestUser(sessionID: string) {
  for await (const m of Message.stream(sessionID)) if (m.info.role === "user") return m.info as Message.UserInfo
  return undefined
}

async function countUsers(sessionID: string) {
  let userCount = 0
  for await (const m of Message.stream(sessionID)) {
    if (m.info.role === "user") userCount++
  }
  return userCount
}

/** Create a session with one user message per history mode, then set the current mode */
async function session(mode: PermissionMode.Value, history: PermissionMode.Value[] = [mode]) {
  const created = await Session.create({})
  for (const item of history) await seedUser(created.id, item)
  await Session.setPermissionMode({ sessionID: created.id, permissionMode: mode })
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

test("findReturnMode skips read-only messages and returns the earlier mode, or ask when there is none", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = await session("readonly", ["auto", "readonly"])
      expect(await findReturnMode(a.id)).toBe("auto")
      const b = await session("readonly", ["readonly"])
      expect(await findReturnMode(b.id)).toBe("ask")
    },
  })
})

test("PlanEnterTool on approval switches to read-only and continues the turn with a read-only message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("ask")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "ask"))
      const pending = await waitForPendingQuestion()
      expect(pending[0].questions[0].dismiss).toBe(false)
      expect(pending[0].questions[0].options.map((o) => o.label)).toEqual(["同意", "跳过"])
      await Question.reply({ requestID: pending[0].id, answers: [["同意"]] })
      const result = await running
      expect(result.metadata).toMatchObject({ switched: true, mode: "readonly" })
      expect((await Session.get(s.id)).permissionMode).toBe("readonly")
      expect(await latestUser(s.id)).toMatchObject({ agent: "build", permissionMode: "readonly" })
      expect(await countUsers(s.id)).toBe(2)
    },
  })
})

test("PlanEnterTool does not switch or ask when already in plan mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("readonly")
      const enter = await PlanEnterTool.init()
      const result = await enter.execute({}, minimalCtx(s.id, "readonly"))
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
      const s = await session("ask")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "ask"))
      const pending = await waitForPendingQuestion()
      await Question.reply({ requestID: pending[0].id, answers: [["跳过"]] })
      const result = await running
      expect(result.title).toBe("Plan mode skipped")
      expect(result.output).toContain("did NOT terminate")
      expect((await Session.get(s.id)).permissionMode).toBe("ask")
      expect(await countUsers(s.id)).toBe(1)
    },
  })
})

test("PlanEnterTool confirmation cannot be dismissed but can still be skipped", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("ask")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "ask"))
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
      const s = await session("ask")
      await Filesystem.write(Session.plan(s), "# existing plan\n")
      const before = Date.now()
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "ask"))
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

test("PlanEnterTool on timeout keeps the current mode and writes no message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("ask")
      const original = Question.ask
      ;(Question as any).ask = (input: Parameters<typeof Question.ask>[0]) => {
        if (input.timeoutMs === undefined) throw new Error("plan_enter must pass timeoutMs")
        return original({ ...input, timeoutMs: 50 })
      }
      try {
        const enter = await PlanEnterTool.init()
        const result = await enter.execute({}, minimalCtx(s.id, "ask"))
        expect(result.title).toBe("Plan mode skipped")
        expect((await Session.get(s.id)).permissionMode).toBe("ask")
        expect(await countUsers(s.id)).toBe(1)
      } finally {
        ;(Question as any).ask = original
      }
    },
  })
})

test("PlanExitTool on approval restores the mode from before plan mode and names it in the prompt", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("readonly", ["auto", "readonly"])
      const exit = await PlanExitTool.init()
      const running = exit.execute({}, minimalCtx(s.id, "readonly"))
      const pending = await waitForPendingQuestion()
      expect(pending[0].questions[0].dismiss).toBe(false)
      expect(pending[0].questions[0].header).toContain("自动")
      await Question.reply({ requestID: pending[0].id, answers: [["同意"]] })
      const result = await running
      expect(result.metadata).toMatchObject({ switched: true, mode: "auto" })
      expect((await Session.get(s.id)).permissionMode).toBe("auto")
      expect(await latestUser(s.id)).toMatchObject({ agent: "build", permissionMode: "auto" })
    },
  })
})

test("PlanExitTool does not switch or ask when not in plan mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("ask")
      const exit = await PlanExitTool.init()
      const result = await exit.execute({}, minimalCtx(s.id, "ask"))
      expect(result.metadata).toMatchObject({ switched: false })
      expect(await Question.list()).toEqual([])
    },
  })
})

test("PlanExitTool question expires in about 15 seconds; skip, timeout and abort stay in plan mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("readonly", ["ask", "readonly"])
      const exit = await PlanExitTool.init()

      const before = Date.now()
      const skipped = exit.execute({}, minimalCtx(s.id, "readonly"))
      const pending = await waitForPendingQuestion()
      const remaining = pending[0].expiresAt! - before
      expect(remaining).toBeGreaterThanOrEqual(10_000)
      expect(remaining).toBeLessThanOrEqual(20_000)
      await Question.reply({ requestID: pending[0].id, answers: [["跳过"]] })
      expect((await skipped).title).toBe("Staying in plan mode")

      const abort = new AbortController()
      const aborted = exit.execute({}, minimalCtx(s.id, "readonly", abort))
      await waitForPendingQuestion()
      abort.abort()
      expect((await aborted).title).toBe("Staying in plan mode")

      const original = Question.ask
      ;(Question as any).ask = (input: Parameters<typeof Question.ask>[0]) => {
        if (input.timeoutMs === undefined) throw new Error("plan_exit must pass timeoutMs")
        return original({ ...input, timeoutMs: 50 })
      }
      try {
        expect((await exit.execute({}, minimalCtx(s.id, "readonly"))).title).toBe("Staying in plan mode")
      } finally {
        ;(Question as any).ask = original
      }
      expect((await Session.get(s.id)).permissionMode).toBe("readonly")
      expect(await countUsers(s.id)).toBe(2)
    },
  })
})

test("PlanEnterTool uses English Yes/Skip labels when locale is en-US", async () => {
  await using tmp = await tmpdir({ git: true, config: { locale: "en-US" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const s = await session("ask")
      const enter = await PlanEnterTool.init()
      const running = enter.execute({}, minimalCtx(s.id, "ask"))
      const pending = await waitForPendingQuestion()
      expect(pending[0].questions[0].options.map((o) => o.label)).toEqual(["Yes", "Skip"])
      await Question.reply({ requestID: pending[0].id, answers: [["Skip"]] })
      expect((await running).title).toBe("Plan mode skipped")
    },
  })
})
