import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { planStayCallExitReminder, resolvePlanReminderKind } from "./plan-reminder"

const runnerSrc = () => readFileSync(join(import.meta.dirname, "runner.ts"), "utf8")

// Plan mode is the readonly mode; the reminder depends on this step's mode and the previous reply's mode.
describe("resolvePlanReminderKind", () => {
  const kind = (input: Partial<Parameters<typeof resolvePlanReminderKind>[0]>) =>
    resolvePlanReminderKind({ planModeEnabled: true, mode: "ask", planExists: false, child: false, ...input })

  test("entering readonly mode (previous reply not readonly, or no reply yet) gives enter", () => {
    expect(kind({ mode: "readonly", lastMode: "ask" })).toBe("enter")
    expect(kind({ mode: "readonly", lastMode: "auto" })).toBe("enter")
    expect(kind({ mode: "readonly", lastMode: undefined })).toBe("enter")
  })

  test("staying in readonly mode gives stay-call-exit with a plan and none without", () => {
    expect(kind({ mode: "readonly", lastMode: "readonly", planExists: true })).toBe("stay-call-exit")
    expect(kind({ mode: "readonly", lastMode: "readonly", planExists: false })).toBe("none")
  })

  test("leaving readonly mode gives build-switch with a plan and none without", () => {
    expect(kind({ mode: "ask", lastMode: "readonly", planExists: true })).toBe("build-switch")
    expect(kind({ mode: "auto", lastMode: "readonly", planExists: true })).toBe("build-switch")
    expect(kind({ mode: "ask", lastMode: "readonly", planExists: false })).toBe("none")
  })

  test("normal turns, subagents and disabled plan mode give none", () => {
    expect(kind({ mode: "ask", lastMode: "ask" })).toBe("none")
    expect(kind({ mode: "readonly", lastMode: "ask", child: true })).toBe("none")
    expect(kind({ mode: "readonly", lastMode: "ask", planModeEnabled: false })).toBe("none")
  })
})

describe("planStayCallExitReminder", () => {
  // Product requirement: the reminder names plan_exit and covers Chinese and English "start implementing" phrases so
  // the model does not edit project files directly.
  test("reminder includes plan_exit, the plan path and Chinese and English implement phrases", () => {
    const text = planStayCallExitReminder("/data/plans/1-demo.md")
    expect(text).toContain("/data/plans/1-demo.md")
    expect(text).toContain("plan_exit")
    expect(text).toMatch(/开始执行/)
    expect(text).toMatch(/开始实施/)
    expect(text).toMatch(/execute the plan/i)
    expect(text).toMatch(/start implementing/i)
    expect(text).toMatch(/MUST NOT|do not edit project files/i)
  })
})

describe("insertReminders wiring", () => {
  // Fails if the runner stops handling stay-call-exit while the pure function remains.
  test("runner calls resolvePlanReminderKind and injects planStayCallExitReminder for stay-call-exit", () => {
    const src = runnerSrc()
    expect(src).toMatch(/resolvePlanReminderKind\s*\(/)
    expect(src).toMatch(/reminderKind === "stay-call-exit"/)
    expect(src).toMatch(/planStayCallExitReminder\s*\(\s*plan\s*\)/)
    // Normal turns skip the disk check; the plan file is only checked when mayNeedPlanFile is set.
    expect(src).toMatch(/mayNeedPlanFile \? await Filesystem\.isFile\(plan\)/)
  })
})
