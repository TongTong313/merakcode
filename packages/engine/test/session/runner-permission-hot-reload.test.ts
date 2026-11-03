/**
 * runner.buildToolExecutionRuleset rebuilds the ruleset before every tool execute, so permission changes (via
 * PUT /safety/permission or session.permission) take effect within the same step. Child sessions always end with
 * subagent: deny, overriding any subagent: allow in session.permission.
 */
import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"

test("buildToolExecutionRuleset applies session.permission changes within the same step (read ask -> deny)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const session = await Session.create({})
      session.permission = PermissionNext.fromConfig({ read: "ask" })
      const ruleset1 = Loop.buildToolExecutionRuleset({ agent: agent!, session })
      expect(PermissionNext.evaluate("read", "*", ruleset1).action).toBe("ask")

      // A current deny rule takes effect before the next operation.
      session.permission = PermissionNext.fromConfig({ read: "deny" })
      const ruleset2 = Loop.buildToolExecutionRuleset({ agent: agent!, session })
      expect(PermissionNext.evaluate("read", "*", ruleset2).action).toBe("deny")
    },
  })
})

test("buildToolExecutionRuleset forces subagent deny in child sessions over an allow in session.permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      // A session with parentID is a child session.
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      child.permission = PermissionNext.fromConfig({ subagent: "allow" })

      const ruleset = Loop.buildToolExecutionRuleset({ agent: agent!, session: child })
      expect(PermissionNext.evaluate("subagent", "*", ruleset).action).toBe("deny")
    },
  })
})

test("buildToolExecutionRuleset bypasses authorization in auto mode including child session rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const session = await Session.create({})
      session.permissionLevel = "fullTakeover"
      const ruleset = Loop.buildToolExecutionRuleset({
        agent: agent!,
        session,
        permissionLevel: "fullTakeover",
      })

      // Full takeover allows the wildcard, including tools like plan/question that the runtime removes separately.
      expect(PermissionNext.evaluate("read", "*", ruleset).action).toBe("allow")
      expect(PermissionNext.evaluate("question", "*", ruleset).action).toBe("allow")
      // A main session in auto mode is not a child session, so subagent is allowed too.
      expect(PermissionNext.evaluate("subagent", "*", ruleset).action).toBe("allow")

      const childRuleset = Loop.buildToolExecutionRuleset({
        agent: agent!,
        session,
        permissionLevel: "fullTakeover",
        child: true,
      })
      expect(PermissionNext.evaluate("read", "*", childRuleset).action).toBe("allow")
      expect(PermissionNext.evaluate("question", "*", childRuleset).action).toBe("allow")
      expect(PermissionNext.evaluate("subagent", "*", childRuleset).action).toBe("deny")
    },
  })
})

test("buildToolExecutionRuleset denies subagent with an explicit child=true even without parentID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const session = await Session.create({})
      const ruleset = Loop.buildToolExecutionRuleset({
        agent: agent!,
        session,
        child: true,
      })

      expect(PermissionNext.evaluate("subagent", "*", ruleset).action).toBe("deny")
    },
  })
})
