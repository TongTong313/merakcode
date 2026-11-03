import { test, expect } from "vitest"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { assertCanWritePlanDoc } from "@merakcode/engine/agent/tools/plan-doc"

import { Session } from "@merakcode/engine/agent/session/index"

test("general file tools cannot edit the official plan", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const planPath = Session.plan(session)
      await expect(
        assertCanWritePlanDoc({ agent: "build", permissionLevel: "ask", sessionID: session.id }, planPath),
      ).rejects.toThrow()
    },
  })
})

test("project plan documents use normal file permissions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const planPath = path.join(Instance.worktree, ".merakcode", "plans", "1700000000000-foo.md")
      const ok = await assertCanWritePlanDoc({ agent: "build", permissionLevel: "ask" }, planPath)
      expect(ok).toBeUndefined()
    },
  })
})

test("ordinary project files use normal file permissions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const srcPath = path.join(Instance.worktree, "src", "foo.ts")
      const ok = await assertCanWritePlanDoc({ agent: "build", permissionLevel: "ask" }, srcPath)
      expect(ok).toBeUndefined()
    },
  })
})
