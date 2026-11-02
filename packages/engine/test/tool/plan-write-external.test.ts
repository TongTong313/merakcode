import { Session } from "@merakcode/engine/agent/session/index"
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
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { EditTool } from "@merakcode/engine/agent/tools/edit"
import { MultiEditTool } from "@merakcode/engine/agent/tools/multi_edit"
import fs from "node:fs/promises"

test.for(
  ["write", "edit-create", "edit-replace", "multi_edit"].flatMap((kind) =>
    ["canonical", "uppercase", "hardlink", "directory-link"].map((alias) => ({ kind, alias })),
  ),
)(
  "$kind respects human plan edits and permits an explicit new revision request ($alias)",
  async ({ kind, alias }, testContext) => {
    await using tmp = await tmpdir({ git: true, config: { lsp: false } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPlan.beginTurn(session.id, "original-request")
        const human = await SessionPlan.save({
          sessionID: session.id,
          source: "human",
          content: "HUMAN",
          expectedRevision: 0,
        })
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "",
          agent: "build",
          sessionMode: "auto",
          abort: new AbortController().signal,
          messages: [],
          ruleset: [],
          extra: { planRevision: human.revision },
          metadata() {},
          async ask() {},
        }
        const linkedDirectory = path.join(tmp.path, "linked-plans")
        if (alias === "directory-link")
          await fs.symlink(path.dirname(human.path), linkedDirectory, process.platform === "win32" ? "junction" : "dir")
        const target =
          alias === "directory-link"
            ? path.join(linkedDirectory, path.basename(human.path))
            : alias === "uppercase"
              ? human.path.replace(/\.md$/, ".MD")
              : alias === "hardlink"
                ? human.path.replace(/\.md$/, "-link.md")
                : human.path
        if (alias === "hardlink") await fs.link(human.path, target)
        if (
          alias === "uppercase" &&
          !(await fs.stat(target).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false
              throw error
            },
          ))
        ) {
          testContext.skip() // Case-sensitive volumes have no alias to protect.
          return
        }
        const read = await ReadTool.init()
        await read.execute({ filePath: target }, ctx)
        const invoke = async () => {
          if (kind === "write") return (await WriteTool.init()).execute({ filePath: target, content: "AI" }, ctx)
          if (kind === "multi_edit")
            return (await MultiEditTool.init()).execute(
              {
                filePath: target,
                edits: [{ oldString: "HUMAN", newString: "AI" }],
              },
              ctx,
            )
          return (await EditTool.init()).execute(
            {
              filePath: target,
              oldString: kind === "edit-create" ? "" : "HUMAN",
              newString: "AI",
            },
            ctx,
          )
        }
        await expect(invoke()).rejects.toThrow(/conflict/i)
        expect((await SessionPlan.get(session.id)).content).toBe("HUMAN")
        await SessionPlan.beginTurn(session.id, "explicit-new-request")
        await invoke()
        expect((await SessionPlan.get(session.id)).content).toBe("AI")
      },
    })
  },
)

/** Same as runner.buildToolExecutionRuleset for ask mode in a top-level session */
function agentRuleset(agent: Agent.Info) {
  return PermissionNext.merge(
    PermissionPolicy.ruleset("execute", agent.permission),
    agent.profile?.restrictedRules ?? [],
  )
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
        const session = await Session.create({})
        const canonical = Session.plan(session)
        // Don't create the file first, or FileTime.assert (read before write) gets in the way
        const target = process.platform === "win32" ? flipDriveCase(canonical) : canonical

        const write = await WriteTool.init()
        const result = await write.execute(
          { filePath: target, content: "# new plan\n" },
          {
            sessionID: session.id,
            messageID: "",
            callID: "",
            agent: "build",
            sessionMode: "plan",
            kind: "plan",
            abort: AbortSignal.any([]),
            messages: [],
            ruleset: PermissionPolicy.ruleset("plan", build!.permission),
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
            kind: "execute",
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
          PermissionPolicy.ruleset("plan", build!.permission),
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
        await expect(assertCanWritePlanDoc({ agent: "build", sessionMode: "execute" }, target)).rejects.toThrow(
          /plan_enter/,
        )
      },
    })
  })
})
