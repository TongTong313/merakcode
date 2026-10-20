import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { Rule } from "@merakcode/engine/rule/rule"
import { RulesPrompt } from "@merakcode/engine/rule/prompt"
import { RuleSession } from "@merakcode/engine/rule/session-state"
import { ContextAttach } from "@merakcode/engine/session/context-attach"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { tmpdir } from "../fixture/fixture"
import { cursorRule, isolate, nativeRule } from "./isolate"
import { Filesystem } from "@merakcode/util/filesystem"

// ContextAttach renders by layer and Rule assigns layers by source. If the values drift, the order of rules relative
// to AGENTS.md would contradict PRECEDENCE_NOTE.
describe("rule layers match the ContextAttach layers", () => {
  test("stay in sync", () => {
    expect(Rule.LAYER["user-config"]).toBe(ContextAttach.Layer.GLOBAL_USER)
    expect(Rule.LAYER.external).toBe(ContextAttach.Layer.EXTERNAL_RULE)
    expect(Rule.LAYER.native).toBe(ContextAttach.Layer.NATIVE_RULE)
  })
})

describe("RulesPrompt.block", () => {
  test("labels a file backed rule with its path", () => {
    const block = RulesPrompt.block({
      id: "/repo/.merakcode/rules/a.mdc",
      name: "a",
      description: "",
      type: "always",
      source: "native",
      scope: "project",
      layer: Rule.LAYER.native,
      filepath: "/repo/.merakcode/rules/a.mdc",
      root: "/repo",
      globs: [],
      exclude: [],
      agents: undefined,
      content: "只写函数组件",
      bytes: 8,
      truncated: false,
    })
    expect(block).toBe("Rule from: /repo/.merakcode/rules/a.mdc\n只写函数组件")
  })

  test("labels a config backed user rule without inventing a path", () => {
    const block = RulesPrompt.block({
      id: "user-config:0",
      name: "user-rule-1",
      description: "",
      type: "always",
      source: "user-config",
      scope: "global",
      layer: Rule.LAYER["user-config"],
      filepath: "",
      root: "/repo",
      globs: [],
      exclude: [],
      agents: undefined,
      content: "用中文回答",
      bytes: 5,
      truncated: false,
    })
    expect(block).toBe("Rule: user-rule-1 (global user rule)\n用中文回答")
  })
})

describe("RulesPrompt.build", () => {
  test("is empty when there are no always rules", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "auto.mdc", "alwaysApply: false\nglobs: src/**"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await RulesPrompt.build()).toEqual({ before: [], after: [], kept: [], dropped: [], bytes: 0 })
        },
      })
    })
  })

  // Global user rules go before AGENTS.md and native project rules after it, ordering the system prompt from general
  // to specific.
  test("splits rules around the AGENTS.md position by layer", async () => {
    await isolate(async (globalDir) => {
      await Filesystem.write(path.join(globalDir, "merakcode.json"), JSON.stringify({ rules: { user: ["GLOBAL"] } }))
      Config.global.reset()
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "n.mdc", "alwaysApply: true", "NATIVE")
          await cursorRule(path.join(dir, "sub"), "e.mdc", "alwaysApply: true", "EXTERNAL")
        },
      })
      await Instance.provide({
        directory: path.join(tmp.path, "sub"),
        fn: async () => {
          const built = await RulesPrompt.build()
          expect(built.before.join("\n")).toContain("GLOBAL")
          expect(built.before.join("\n")).toContain("EXTERNAL")
          expect(built.after.join("\n")).toContain("NATIVE")
          // External rules are more specific than global user rules, so they come after them.
          expect(built.before.findIndex((b) => b.includes("GLOBAL"))).toBeLessThan(
            built.before.findIndex((b) => b.includes("EXTERNAL")),
          )
          expect(built.dropped).toEqual([])
        },
      })
    })
  })

  test("orders same layer rules shallow to deep", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "root.mdc", "alwaysApply: true", "SHALLOW")
          await nativeRule(path.join(dir, "pkg"), "deep.mdc", "alwaysApply: true", "DEEP")
        },
      })
      await Instance.provide({
        directory: path.join(tmp.path, "pkg"),
        fn: async () => {
          const built = await RulesPrompt.build()
          expect(built.after.findIndex((b) => b.includes("SHALLOW"))).toBeLessThan(
            built.after.findIndex((b) => b.includes("DEEP")),
          )
        },
      })
    })
  })

  // A dozen always rules can fill the whole context window without the user noticing that rules are the cause.
  test("drops the most general rules first once the byte pool is exhausted", async () => {
    await isolate(async (globalDir) => {
      const filler = "x".repeat(Rule.MAX_BYTES - 200)
      await Filesystem.write(
        path.join(globalDir, "merakcode.json"),
        JSON.stringify({ rules: { user: [`GLOBAL ${filler}`] } }),
      )
      Config.global.reset()
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          for (const name of ["a", "b", "c"]) {
            await nativeRule(dir, `${name}.mdc`, "alwaysApply: true", `NATIVE-${name} ${filler}`)
          }
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const built = await RulesPrompt.build()
          expect(built.bytes).toBeLessThanOrEqual(RulesPrompt.MAX_SYSTEM_BYTES)
          expect(built.dropped.length).toBeGreaterThan(0)
          // Keep the more specific rules, since specific rules take precedence over general ones.
          expect(built.dropped.map((r) => r.source)).toContain("user-config")
          expect(built.after.join("\n")).toContain("NATIVE-c")
        },
      })
    })
  })

  test("includes rules.user from the global config as always rules", async () => {
    await isolate(async (globalDir) => {
      await Filesystem.write(
        path.join(globalDir, "merakcode.json"),
        JSON.stringify({ rules: { user: ["总是用中文回答"] } }),
      )
      Config.global.reset()
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const built = await RulesPrompt.build()
          expect(built.before.join("\n")).toContain("总是用中文回答")
          expect(built.after).toEqual([])
        },
      })
    })
  })

  test("always rules honor the agents gate", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "open.mdc", "alwaysApply: true", "OPEN")
          await nativeRule(dir, "planonly.mdc", "alwaysApply: true\nagents: [plan]", "PLAN-ONLY")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const forBuild = await RulesPrompt.build({ agent: "build" })
          expect(forBuild.after.join("\n")).toContain("OPEN")
          expect(forBuild.after.join("\n")).not.toContain("PLAN-ONLY")

          const forPlan = await RulesPrompt.build({ agent: "plan" })
          expect(forPlan.after.join("\n")).toContain("OPEN")
          expect(forPlan.after.join("\n")).toContain("PLAN-ONLY")
        },
      })
    })
  })
})

describe("RulesPrompt.snapshot", () => {
  test("lists kept always rules and working-set auto rules only", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "always.mdc", "alwaysApply: true", "ALWAYS")
          await nativeRule(dir, "ts.mdc", 'alwaysApply: false\nglobs: "**/*.ts"', "TS-RULE")
          await nativeRule(dir, "css.mdc", 'alwaysApply: false\nglobs: "**/*.css"', "CSS-RULE")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const userMessageID = "usr_touch"
          await RuleSession.noteUserTurn(session.id, userMessageID)
          await RuleSession.recordFile(session.id, path.join(tmp.path, "src", "a.ts"), userMessageID)

          const snap = await RulesPrompt.snapshot({ sessionID: session.id, agent: "build" })
          expect(snap.always.map((r) => r.name)).toEqual(["always"])
          expect(snap.glob.map((r) => r.name)).toEqual(["ts"])
          expect(snap.glob.map((r) => r.name)).not.toContain("css")
          expect(snap.dropped).toEqual([])
          expect(snap.alwaysBudget).toBe(RulesPrompt.MAX_SYSTEM_BYTES)
          await Session.remove(session.id)
        },
      })
    })
  })

  test("matches a nested file against a repo-root glob via the working set", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "ts.mdc", 'alwaysApply: false\nglobs: "**/*.ts"', "TS-RULE")
          await Filesystem.write(path.join(dir, "pkg", "src", "a.ts"), "const x = 1")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const userMessageID = "usr_nested"
          await RuleSession.noteUserTurn(session.id, userMessageID)
          await RuleSession.recordFile(session.id, path.join(tmp.path, "pkg", "src", "a.ts"), userMessageID)
          const active = await RulesPrompt.active({ sessionID: session.id, agent: "build", messages: [] })
          expect(active.glob.map((r) => r.name)).toEqual(["ts"])
          expect(active.blocks.join("\n")).toContain("TS-RULE")
          await Session.remove(session.id)
        },
      })
    })
  })

  test("lists a pinned manual rule without listing an unread auto rule", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "review.mdc", "alwaysApply: false\nname: review", "MANUAL")
          await nativeRule(dir, "ts.mdc", 'alwaysApply: false\nglobs: "**/*.ts"', "TS-RULE")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const filepath = path.join(tmp.path, ".merakcode", "rules", "review.mdc")
          await RuleSession.pin(session.id, filepath, "mention")

          const snap = await RulesPrompt.snapshot({ sessionID: session.id, agent: "build" })
          expect(snap.pinned.map((r) => r.name)).toEqual(["review"])
          expect(snap.pinned[0].type).toBe("manual")
          expect(snap.glob).toEqual([])
          await Session.remove(session.id)
        },
      })
    })
  })

  test("lists agent-requested rules in the catalog without injecting their body", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "rpc.mdc", "alwaysApply: false\nname: rpc\ndescription: RPC 约定", "RPC-BODY"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const built = await RulesPrompt.catalog({ agent: "build" })
          expect(built.text).toContain("rpc")
          expect(built.text).toContain("RPC 约定")
          expect(built.text).not.toContain("RPC-BODY")
          const active = await RulesPrompt.active({ sessionID: "none", agent: "build", messages: [] })
          expect(active.pinned).toEqual([])
          expect(active.blocks).toEqual([])
        },
      })
    })
  })

  test("includes load errors and shadowed cursor directories", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "ok.mdc", "alwaysApply: true", "OK")
          await nativeRule(dir, "hollow.mdc", "alwaysApply: true", "")
          await cursorRule(dir, "hidden.mdc", "alwaysApply: true", "HIDDEN")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const snap = await RulesPrompt.snapshot({ sessionID: "sess_err", agent: "build" })
          expect(snap.errors.some((item) => item.reason === "规则正文为空")).toBe(true)
          expect(snap.shadowed.length).toBe(1)
          expect(snap.shadowed[0].directory).toBe(path.join(tmp.path, ".cursor", "rules"))
        },
      })
    })
  })

  test("omits shadowed when .cursor/rules exists but has no .mdc", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "ok.mdc", "alwaysApply: true", "OK")
          await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true })
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const snap = await RulesPrompt.snapshot({ sessionID: "sess_empty_cursor", agent: "build" })
          expect(snap.shadowed).toEqual([])
        },
      })
    })
  })
})
