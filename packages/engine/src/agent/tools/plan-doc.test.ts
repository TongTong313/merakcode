import { describe, expect, test } from "vitest"
import path from "path"
import { assertCanWritePlanDoc, assertPlanModeAllowsWrite, isUnderPlansDataDir } from "./plan-doc"

// Only the current root session plan may be written in plan mode.
const build = { agent: "build", sessionMode: "execute" as const }
import { Instance } from "../../infra/project/instance"
import { Session } from "../session"
import { tmpdir } from "../../../test/fixture/fixture"

async function withPlan(
  fn: (author: { agent: string; sessionMode: "plan"; sessionID: string }, target: string) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await fn({ agent: "build", sessionMode: "plan", sessionID: session.id }, Session.plan(session))
    },
  })
}

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
    await withPlan(async (author, target) => {
      await assertCanWritePlanDoc(author, target)
      await expect(assertCanWritePlanDoc(author, path.join(path.dirname(target), "another.md"))).rejects.toThrow()
    })
  })
})

describe("assertPlanModeAllowsWrite", () => {
  test("allows writes outside plan mode", async () => {
    await assertPlanModeAllowsWrite(build, path.join("/tmp", "src", "a.ts"))
  })

  test("rejects writing project files in plan mode and points to plan_exit", async () => {
    await withPlan(async (author) => {
      await expect(assertPlanModeAllowsWrite(author, path.join("/tmp", "src", "a.ts"))).rejects.toThrow(/plan_exit/)
    })
  })

  test("allows writing a plan in plan mode", async () => {
    await withPlan(async (author, target) => assertPlanModeAllowsWrite(author, target))
  })
})
