import { test, expect } from "vitest"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { isPlanDocBypass } from "@merakcode/engine/agent/tools/plan-doc"

import { Session } from "@merakcode/engine/agent/session/index"

test("plan mode allows editing .md files under Global.Path.data/plans", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const planPath = Session.plan(session)
      const ok = await isPlanDocBypass({ agent: "build", sessionMode: "plan", sessionID: session.id }, planPath)
      expect(ok).toBe(true)
    },
  })
})

test("plan mode rejects .md files under the project's .merakcode/plans", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const planPath = path.join(Instance.worktree, ".merakcode", "plans", "1700000000000-foo.md")
      const ok = await isPlanDocBypass({ agent: "build", sessionMode: "plan" }, planPath)
      expect(ok).toBe(false)
    },
  })
})

test("plan mode rejects files outside the plan directory", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const srcPath = path.join(Instance.worktree, "src", "foo.ts")
      const ok = await isPlanDocBypass({ agent: "build", sessionMode: "plan" }, srcPath)
      expect(ok).toBe(false)
    },
  })
})
