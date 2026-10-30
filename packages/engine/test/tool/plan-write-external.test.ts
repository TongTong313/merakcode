import { describe, expect, test } from "vitest"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Agent } from "@merakcode/engine/agent/agent"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Identifier } from "@merakcode/util/id"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { WriteTool } from "@merakcode/engine/agent/tools/write"
import { ReadTool } from "@merakcode/engine/agent/tools/read"
import { assertCanWritePlanDoc } from "@merakcode/engine/agent/tools/plan-doc"
import { Global } from "@merakcode/engine/infra/global/index"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { Filesystem } from "@merakcode/util/filesystem"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"

/** Same as runner.buildToolExecutionRuleset for ask mode in a top-level session */
function agentRuleset(agent: Agent.Info) {
  return PermissionNext.merge(PermissionPolicy.ruleset("ask", agent.permission), agent.profile?.restrictedRules ?? [])
}

/** Flip the Windows drive letter case, as a model or UI may pass a path that differs from Global.Path.data */
function flipDriveCase(p: string): string {
  return p.replace(/^([A-Za-z]):/, (_, d: string) => (/[A-Z]/.test(d) ? `${d.toLowerCase()}:` : `${d.toUpperCase()}:`))
}

describe("official plan path: write guard and approval-free plan reads and writes", () => {
  test("writing the official plan in plan mode does not ask, even with a different drive letter case", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const canonical = path.join(Global.Path.data, "plans", "1780000000001-write-guard.md")
        // Don't create the file first, or FileTime.assert (read before write) gets in the way
        const target = process.platform === "win32" ? flipDriveCase(canonical) : canonical

        const write = await WriteTool.init()
        const result = await write.execute(
          { filePath: target, content: "# new plan\n" },
          {
            sessionID: "test",
            messageID: "",
            callID: "",
            agent: "build",
            permissionMode: "readonly",
            kind: "readonly",
            abort: AbortSignal.any([]),
            messages: [],
            ruleset: PermissionPolicy.ruleset("readonly", build!.permission),
            metadata: async () => {},
            ask: async () => {
              throw new Error("plan bypass must not ask for write")
            },
          },
        )
        expect(result.output).toContain("successfully")
        // The write may land on the flipped path; on Windows it is the same file as canonical
        const written = (await Filesystem.isFile(canonical)) ? canonical : target
        expect(await Filesystem.readText(written)).toContain("new plan")
      },
    })
  })

  test("build agent reads the official plan outside the workspace without approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        expect(build).toBeDefined()
        const planPath = path.join(Global.Path.data, "plans", "1780000000002-read-guard.md")
        await Filesystem.write(planPath, "# plan\n")

        const ruleset = agentRuleset(build!)

        const asked: PermissionNext.Request[] = []
        const sessionID = Identifier.ascending("session")
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          asked.push(event.properties)
          void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
        })
        try {
          const read = await ReadTool.init()
          const ctx: Tool.Context = {
            sessionID,
            messageID: "",
            callID: "",
            agent: "build",
            kind: "ask",
            abort: AbortSignal.any([]),
            messages: [],
            ruleset,
            metadata: async () => {},
            ask: (request) => PermissionNext.ask({ ...request, sessionID, ruleset }),
          }
          const result = await read.execute({ filePath: planPath }, ctx)
          expect(result.output).toContain("# plan")
        } finally {
          unsubscribe()
        }
        expect(asked).toEqual([])
      },
    })
  })

  test("writing project source in plan mode is denied", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const src = path.join(tmp.path, "src", "foo.ts")
        const action = PermissionNext.evaluate(
          "edit",
          PermissionNext.normalizePath(src),
          PermissionPolicy.ruleset("readonly", build!.permission),
        ).action
        expect(action).toBe("deny")
      },
    })
  })

  test("build agent writing the official plan makes assertCanWritePlanDoc point to plan_enter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const target = path.join(Global.Path.data, "plans", "1780000000003-build-deny.md")
        await expect(assertCanWritePlanDoc({ agent: "build", permissionMode: "ask" }, target)).rejects.toThrow(
          /plan_enter/,
        )
      },
    })
  })
})
