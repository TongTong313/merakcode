import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { WriteTool } from "@merakcode/engine/agent/tools/write"
import { ReadTool } from "@merakcode/engine/agent/tools/read"
import { PlanGenerateTool } from "@merakcode/engine/agent/tools/plan"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Identifier } from "@merakcode/util/id"

test("a synthetic continuation cannot remove the original draft scope", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      await Loop.prompt({
        sessionID: session.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "只出稿，不要修改项目。" }],
      })
      await Loop.promptGenerated({
        sessionID: session.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Continue after compaction.", synthetic: true }],
      })
      const parentID = (await Session.messages({ sessionID: session.id })).at(-1)!.info.id
      const messageID = Identifier.ascending("message")
      await Session.updateInfo({
        id: messageID,
        parentID,
        sessionID: session.id,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        providerID: "openai",
        modelID: "gpt-4",
        time: { created: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID,
        callID: "call_continued",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: PermissionPolicy.ruleset("fullTakeover"),
        metadata: () => {},
        ask: (request) =>
          PermissionNext.askCurrent(
            { ...request, sessionID: session.id, tool: { messageID, callID: "call_continued" } },
            async () => PermissionPolicy.ruleset("fullTakeover"),
          ),
      }
      const filePath = path.join(tmp.path, "effect.txt")
      await expect((await WriteTool.init()).execute({ filePath, content: "CHANGED" }, ctx)).rejects.toMatchObject({
        name: "TaskScopeDeniedError",
      })
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
    },
  })
})

test("fullTakeover respects an explicit draft-only request while allowing the official plan", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      await Loop.prompt({
        sessionID: session.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "给我一个迁移方案，先供审核。只出稿，不要修改项目。" }],
      })
      const file = path.join(tmp.path, "source.ts")
      await fs.writeFile(file, "KEEP")
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_draft",
        callID: "call_draft",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: PermissionPolicy.ruleset("fullTakeover"),
        metadata: () => {},
        ask: (input) =>
          PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
            PermissionPolicy.ruleset("fullTakeover"),
          ),
      }
      await (await ReadTool.init()).execute({ filePath: file }, ctx)
      await expect((await WriteTool.init()).execute({ filePath: file, content: "CHANGED" }, ctx)).rejects.toMatchObject(
        { name: "TaskScopeDeniedError" },
      )
      expect(await fs.readFile(file, "utf8")).toBe("KEEP")
      await (
        await PlanGenerateTool.init()
      ).execute({ content: "# Migration\nReview before implementation.", expectedRevision: 0 }, ctx)
      expect((await SessionPlan.get(session.id)).content).toContain("Review before implementation")
    },
  })
})

test("a draft child keeps its original scope after a later unrelated root message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      await selectPermissionLevel({ sessionID: root.id, permissionLevel: "fullTakeover" })
      await Loop.prompt({
        sessionID: root.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "只出稿，不要修改项目。" }],
      })
      const child = await Session.create({ parentID: root.id })
      await Loop.prompt({
        sessionID: root.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "解释一下 TypeScript。" }],
      })
      const ctx: Tool.Context = {
        sessionID: child.id,
        messageID: "msg_child",
        callID: "call_child",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: PermissionPolicy.ruleset("fullTakeover"),
        metadata: () => {},
        ask: (input) =>
          PermissionNext.askCurrent({ ...input, sessionID: child.id, root: root.id }, async () =>
            PermissionPolicy.ruleset("fullTakeover"),
          ),
      }
      await expect(
        (await WriteTool.init()).execute({ filePath: path.join(tmp.path, "blocked.txt"), content: "CHANGED" }, ctx),
      ).rejects.toMatchObject({ name: "TaskScopeDeniedError" })
      await expect(fs.stat(path.join(tmp.path, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    },
  })
})

test("a request to plan and then implement does not become draft-only", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      await Loop.prompt({
        sessionID: session.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "先编写方案再实施，按方案修改项目。" }],
      })
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: "msg_implement",
        callID: "call_implement",
        agent: "build",
        permissionLevel: "fullTakeover",
        abort: new AbortController().signal,
        messages: [],
        ruleset: PermissionPolicy.ruleset("fullTakeover"),
        metadata: () => {},
        ask: (input) =>
          PermissionNext.askCurrent({ ...input, sessionID: session.id }, async () =>
            PermissionPolicy.ruleset("fullTakeover"),
          ),
      }
      await (
        await WriteTool.init()
      ).execute({ filePath: path.join(tmp.path, "allowed.txt"), content: "IMPLEMENTED" }, ctx)
      expect(await fs.readFile(path.join(tmp.path, "allowed.txt"), "utf8")).toBe("IMPLEMENTED")
    },
  })
})

test.each([true, false])("a child's own draft request narrows an implementation parent (message=%s)", async (bound) => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      await selectPermissionLevel({ sessionID: root.id, permissionLevel: "fullTakeover" })
      await Loop.prompt({
        sessionID: root.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "开始实施当前任务。" }],
      })
      const child = await Session.create({ parentID: root.id })
      const source = await Loop.prompt({
        sessionID: child.id,
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "只出稿，不要修改项目。" }],
      })
      const messageID = bound ? source.info.id : "msg_unscoped_child"
      const filePath = path.join(tmp.path, "child-scope-effect.txt")
      await expect(
        (await WriteTool.init()).execute(
          { filePath, content: "CHANGED" },
          {
            sessionID: child.id,
            messageID,
            callID: "child-local-scope",
            agent: "build",
            permissionLevel: "fullTakeover",
            abort: new AbortController().signal,
            messages: [],
            ruleset: [],
            metadata() {},
            ask: (request) =>
              PermissionNext.askCurrent(
                { ...request, sessionID: child.id, root: root.id, tool: { messageID, callID: "child-local-scope" } },
                async () => PermissionPolicy.ruleset("fullTakeover"),
              ),
          },
        ),
      ).rejects.toMatchObject({ name: "TaskScopeDeniedError" })
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
    },
  })
})
