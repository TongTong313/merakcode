import { SessionOperations } from "@merakcode/engine/app/session"
import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { RuleSession } from "@merakcode/engine/agent/prompt/rules/session-state"
import { RulesPrompt } from "@merakcode/engine/agent/prompt/rules/prompt"
import { RuleTool } from "@merakcode/engine/agent/tools/rule"
import { tmpdir } from "../fixture/fixture"
import { isolate, nativeRule } from "./isolate"

function toolCtx(sessionID: string, agent = "build") {
  return {
    sessionID,
    messageID: "m1",
    agent,
    abort: new AbortController().signal,
    messages: [],
    ruleset: [],
    metadata: async () => {},
    ask: async () => {},
    askExternalDirectory: async () => {},
  }
}

describe("rule tool fetch", () => {
  test("pins an agent-requested rule and does not dump the body", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "rpc.mdc", "alwaysApply: false\nname: rpc\ndescription: RPC 约定", "RPC-BODY"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const tool = await RuleTool.init()
          const result = await tool.execute({ name: "rpc" }, toolCtx(session.id))
          expect(result.output).toContain("is now active for this session")
          expect(result.output).not.toContain("RPC-BODY")
          const pinned = await RuleSession.snapshot(session.id)
          expect(pinned.pinned[0]?.source).toBe("fetch")
          const active = await RulesPrompt.active({ sessionID: session.id, agent: "build", messages: [] })
          expect(active.pinned.map((r) => r.name)).toEqual(["rpc"])
          expect(active.blocks.join("\n")).toContain("RPC-BODY")
          await SessionOperations.remove(session.id)
        },
      })
    })
  })

  test("rejects auto rules and honors the agents gate", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "ts.mdc", "alwaysApply: false\nname: ts\nglobs: '**/*.ts'", "TS-BODY")
          await nativeRule(
            dir,
            "plan.mdc",
            "alwaysApply: false\nname: planrpc\ndescription: plan only\nagents: [plan]",
            "PLAN-BODY",
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const tool = await RuleTool.init()
          const auto = await tool.execute({ name: "ts" }, toolCtx(session.id))
          expect(auto.output).toContain("is not an Apply Intelligently rule")
          const gated = await tool.execute({ name: "planrpc" }, toolCtx(session.id, "build"))
          expect(gated.output).toContain("is not available")
          const ok = await tool.execute({ name: "planrpc" }, toolCtx(session.id, "plan"))
          expect(ok.output).toContain("is now active for this session")
          await SessionOperations.remove(session.id)
        },
      })
    })
  })
})
