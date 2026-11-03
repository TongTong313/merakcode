import { expect, test } from "vitest"
import { ToolRegistry } from "@merakcode/engine/agent/tools/registry"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { ReadTool } from "@merakcode/engine/agent/tools/read"
import { WriteTool } from "@merakcode/engine/agent/tools/write"
import fs from "node:fs/promises"
import path from "node:path"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { PlanGenerateTool, PlanEditTool, PlanReadChunkTool } from "@merakcode/engine/agent/tools/plan"

test.each(["executing", "paused"] as const)(
  "plan tools read the fixed snapshot while %s after human edits",
  async (status) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const child = await Session.create({ parentID: session.id })
        await SessionPlan.save({ sessionID: session.id, source: "human", content: "FIXED_A", expectedRevision: 0 })
        const started = await SessionPlan.start(session.id)
        await SessionPlan.save({ sessionID: session.id, source: "human", content: "EDITABLE_B", expectedRevision: 1 })
        await SessionPlan.setStatus(session.id, status)
        for (const sessionID of [session.id, child.id]) {
          const ctx: Tool.Context = {
            sessionID,
            messageID: "msg_read",
            callID: "call_read",
            agent: "build",
            permissionLevel: "fullTakeover",
            abort: new AbortController().signal,
            messages: [],
            ruleset: [],
            metadata: () => {},
            ask: async () => {},
          }
          const chunk = JSON.parse(
            (await (await PlanReadChunkTool.init()).execute({ offset: 0, limit: 8000 }, ctx)).output,
          )
          expect(chunk).toMatchObject({ content: "FIXED_A", executionID: started.execution?.id, revision: 1 })
          const read = await (await ReadTool.init()).execute({ filePath: started.path }, ctx)
          expect(read.output).toContain("FIXED_A")
          expect(read.output).not.toContain("EDITABLE_B")
        }
        expect((await SessionPlan.get(session.id)).content).toBe("EDITABLE_B")
      },
    })
  },
)

test("a successful plan submission can be retried without a second save or moving its first card", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_first",
        callID: "call_first",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata: () => {},
        ask: async () => {},
      }
      const tool = await PlanGenerateTool.init()
      const first = await tool.execute({ content: "# A", expectedRevision: 0 }, ctx)
      expect(await tool.execute({ content: "# A", expectedRevision: 0 }, ctx)).toEqual(first)
      const saved = await SessionPlan.get(session.id)
      expect(saved).toMatchObject({ revision: 1, anchorMessageID: "msg_first", status: "review" })
      await SessionPlan.save({ sessionID: session.id, source: "human", content: "# Human", expectedRevision: 1 })
      expect(await tool.execute({ content: "# A", expectedRevision: 0 }, ctx)).toEqual(first)
      expect((await SessionPlan.get(session.id)).content).toBe("# Human")
      await tool.execute(
        { content: "# B", expectedRevision: 2 },
        { ...ctx, messageID: "msg_second", callID: "call_second" },
      )
      expect((await SessionPlan.get(session.id)).anchorMessageID).toBe("msg_first")
    },
  })
})

test("a successful local plan edit returns its original receipt when retried", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        content: "# A\nOriginal passage",
        expectedRevision: 0,
      })
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_edit",
        callID: "call_edit",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata: () => {},
        ask: async () => {},
      }
      const params = { oldString: "Original passage", newString: "Edited passage", expectedRevision: 1 }
      const tool = await PlanEditTool.init()
      const first = await tool.execute(params, ctx)
      expect(await tool.execute(params, ctx)).toEqual(first)
      expect(await SessionPlan.get(session.id)).toMatchObject({ content: "# A\nEdited passage", revision: 2 })
    },
  })
})

test("the official plan has one generation entry point without permission mode switching", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ids = await ToolRegistry.ids()
      expect(ids).toContain("plan_generate")
      expect(ids).toContain("plan_edit")
      expect(ids).toContain("plan_read_chunk")
      expect(ids).toContain("plan_simplify")
      expect(ids).not.toContain("plan_write")
      expect(ids).not.toContain("plan_enter")
      expect(ids).not.toContain("plan_exit")
    },
  })
})

test("general file tools cannot overwrite the official plan through a hard link", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const plan = await SessionPlan.save({
        sessionID: session.id,
        content: "HUMAN",
        expectedRevision: 0,
        source: "human",
      })
      const alias = path.join(tmp.path, "alias.md")
      await fs.link(plan.path, alias)
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_plan",
        callID: "call_plan",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata: async () => {},
        ask: async () => {},
      }
      await (await ReadTool.init()).execute({ filePath: alias }, ctx)
      await expect(
        (await WriteTool.init()).execute({ filePath: alias, content: "UNAUTHORIZED" }, ctx),
      ).rejects.toBeInstanceOf(SessionPlan.ConflictError)
      expect((await SessionPlan.get(session.id)).content).toBe("HUMAN")
    },
  })
})

test("external tools cannot replace the official plan generation entry point", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const original = (await ToolRegistry.tools({ providerID: "openai", modelID: "gpt-4" })).find(
        (tool) => tool.id === "plan_generate",
      )!
      await ToolRegistry.register({ id: "plan_generate", init: async () => original })
      const matching = (await ToolRegistry.tools({ providerID: "openai", modelID: "gpt-4" })).filter(
        (tool) => tool.id === "plan_generate",
      )
      expect(matching).toHaveLength(1)
      expect(matching[0]!.origin).toBe("builtin")
    },
  })
})
