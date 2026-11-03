import { Session } from "@merakcode/engine/agent/session/index"
import { expect, test } from "vitest"
import path from "path"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Identifier } from "@merakcode/util/id"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { WriteTool } from "@merakcode/engine/agent/tools/write"
import { ReadTool } from "@merakcode/engine/agent/tools/read"
import { assertCanWritePlanDoc } from "@merakcode/engine/agent/tools/plan-doc"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { EditTool } from "@merakcode/engine/agent/tools/edit"
import { MultiEditTool } from "@merakcode/engine/agent/tools/multi_edit"
import fs from "node:fs/promises"

test.for(
  ["write", "edit-create", "edit-replace", "multi_edit"].flatMap((kind) =>
    ["canonical", "uppercase", "hardlink", "directory-link"].map((alias) => ({ kind, alias })),
  ),
)("$kind cannot modify the official plan before or after a new task ($alias)", async ({ kind, alias }, testContext) => {
  await using tmp = await tmpdir({ git: true, config: { lsp: false } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
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
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        extra: { planRevision: human.revision },
        metadata() {},
        ask: (request) =>
          PermissionNext.askCurrent({ ...request, sessionID: session.id }, async () =>
            PermissionPolicy.ruleset("fullTakeover"),
          ),
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
      await expect(invoke()).rejects.toBeInstanceOf(SessionPlan.ConflictError)
      expect((await SessionPlan.get(session.id)).content).toBe("HUMAN")
      await SessionPlan.beginTurn(session.id, Identifier.ascending("message"))
      await expect(invoke()).rejects.toBeInstanceOf(SessionPlan.ConflictError)
      expect((await SessionPlan.get(session.id)).content).toBe("HUMAN")
    },
  })
})

test("official plan reads still require each approval in ask without isolation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const plan = await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        content: "# Official plan",
        expectedRevision: 0,
      })
      const asked: PermissionNext.Request[] = []
      const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        asked.push(event.properties)
        void PermissionNext.reply({
          requestID: event.properties.id,
          reply: "once",
          decisionRevision: event.properties.decisionRevision,
        })
      })
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: Identifier.ascending("message"),
        callID: "plan-read",
        agent: "build",
        permissionLevel: "ask",
        abort: new AbortController().signal,
        messages: [],
        ruleset: PermissionPolicy.ruleset("ask"),
        metadata: () => {},
        ask: (request) =>
          PermissionNext.askCurrent({ ...request, sessionID: session.id }, async () => PermissionPolicy.ruleset("ask")),
      }
      try {
        for (let index = 0; index < 2; index++)
          expect((await (await ReadTool.init()).execute({ filePath: plan.path }, ctx)).output).toContain(
            "# Official plan",
          )
        expect(asked).toHaveLength(2)
      } finally {
        off()
      }
    },
  })
})

test("the write guard directs every permission level to the dedicated official plan tools", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      for (const permissionLevel of ["ask", "autoApprove", "fullTakeover"] as const)
        await expect(
          assertCanWritePlanDoc({ agent: "build", permissionLevel, sessionID: session.id }, Session.plan(session)),
        ).rejects.toMatchObject({
          name: "PlanConflictError",
          data: { message: expect.stringMatching(/官方计划工具|official plan tools/) },
        })
    },
  })
})
