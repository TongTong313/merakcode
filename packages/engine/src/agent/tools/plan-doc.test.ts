import { describe, expect, test } from "vitest"
import path from "path"
import { assertCanWritePlanDoc, assertPlanModeAllowsWrite, isUnderPlansDataDir } from "./plan-doc"

// Plan mode is the read-only mode; a context without a session counts as the main session
const build = { agent: "build", permissionMode: "ask" as const }
const planning = { agent: "build", permissionMode: "readonly" as const }

const PLANS = path.join("/tmp", "mc-data", "plans")

describe("isUnderPlansDataDir", () => {
  test("accepts .md files under plans", () => {
    expect(isUnderPlansDataDir(path.join(PLANS, "1-a.md"), PLANS)).toBe(true)
  })

  test("rejects non-markdown files and files outside the directory", () => {
    expect(isUnderPlansDataDir(path.join(PLANS, "1-a.ts"), PLANS)).toBe(false)
    expect(isUnderPlansDataDir(path.join("/tmp", "other", "1-a.md"), PLANS)).toBe(false)
  })

  // path.startsWith fails when the Windows drive letter case differs, which is why Filesystem.contains is used
  test.skipIf(process.platform !== "win32")("matches when the Windows drive letter case differs", () => {
    const plans = "C:\\Users\\x\\AppData\\Local\\merakcode\\plans"
    const file = "c:\\Users\\x\\AppData\\Local\\merakcode\\plans\\1-a.md"
    expect(isUnderPlansDataDir(file, plans)).toBe(true)
  })
})

describe("assertCanWritePlanDoc", () => {
  test("allows paths outside plans in any mode", async () => {
    await assertCanWritePlanDoc(build, path.join("/tmp", "src", "a.ts"))
  })

  test("rejects writing a plan outside plan mode and points to plan_enter", async () => {
    // Uses the real Global.Path.data/plans; without a bypass the build agent must fail
    const { Global } = await import("../../infra/global")
    const target = path.join(Global.Path.data, "plans", "1780000000000-test-plan.md")
    let err: Error | undefined
    try {
      await assertCanWritePlanDoc(build, target)
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    expect(err).toBeDefined()
    expect(err!.message).toMatch(/plan_enter/)
  })

  test("allows writing a plan in plan mode", async () => {
    const { Global } = await import("../../infra/global")
    const target = path.join(Global.Path.data, "plans", "1780000000000-test-plan.md")
    await assertCanWritePlanDoc(planning, target)
  })
})

describe("assertPlanModeAllowsWrite", () => {
  test("allows writes outside plan mode", async () => {
    await assertPlanModeAllowsWrite(build, path.join("/tmp", "src", "a.ts"))
  })

  test("rejects writing project files in plan mode and points to plan_exit", async () => {
    let err: Error | undefined
    try {
      await assertPlanModeAllowsWrite(planning, path.join("/tmp", "src", "a.ts"))
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e))
    }
    expect(err).toBeDefined()
    expect(err!.message).toMatch(/plan_exit/)
    expect(err!.message).toMatch(/plan mode/i)
  })

  test("allows writing a plan in plan mode", async () => {
    const { Global } = await import("../../infra/global")
    const target = path.join(Global.Path.data, "plans", "1780000000000-test-plan.md")
    await assertPlanModeAllowsWrite(planning, target)
  })
})
