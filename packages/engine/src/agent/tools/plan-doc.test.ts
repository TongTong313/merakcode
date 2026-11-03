import { describe, expect, test } from "vitest"
import path from "path"
import { assertCanWritePlanDoc, isUnderPlansDataDir } from "./plan-doc"

// Only the current root session plan may be written in plan mode.
const build = { agent: "build", permissionLevel: "autoApprove" as const }
import { Instance } from "../../infra/project/instance"
import { Session } from "../session"
import { tmpdir } from "../../../test/fixture/fixture"

async function withPlan(
  fn: (author: { agent: string; permissionLevel: "ask"; sessionID: string }, target: string) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await fn({ agent: "build", permissionLevel: "ask", sessionID: session.id }, Session.plan(session))
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

  test("rejects generic writes to an official plan in every permission level", async () => {
    await withPlan(async (author, target) => {
      for (const permissionLevel of ["ask", "autoApprove", "fullTakeover"] as const)
        await expect(assertCanWritePlanDoc({ ...author, permissionLevel }, target)).rejects.toThrow()
    })
  })
})
