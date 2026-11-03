import { test, expect } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Identifier } from "@merakcode/util/id"
import { SessionProcessor } from "@merakcode/engine/agent/loop/processor"
import { Message } from "@merakcode/engine/agent/session/message"
import { WriteTool } from "@merakcode/engine/agent/tools/write"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import type { PermissionLevel } from "@merakcode/engine/agent/permission/level"
import { Filesystem } from "@merakcode/util/filesystem"
import { Bus } from "../../src/infra/bus"
import { PlanGenerateTool } from "../../src/agent/tools/plan"
import { BashTool } from "@merakcode/engine/agent/tools/bash"

async function draftTurn(sessionID: string) {
  const user = await Session.updateInfo({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  const part: Message.TextPart = {
    id: Identifier.ascending("part"),
    sessionID,
    messageID: user.id,
    type: "text",
    text: "Draft only. Research and save the official plan. Do not modify project files.",
  }
  await Session.updatePart(part)
  const assistant = await Session.updateInfo({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: user.id,
    time: { created: Date.now() },
  })
  return { messageID: assistant.id, messages: [{ info: user, parts: [part] }] }
}

test.each(["> note.txt", "cd . > note.txt", "sort -osorted.txt data.txt", "sort -uo./sorted.txt data.txt"])(
  "a draft-only task rejects file-writing shell syntax %s before touching project files",
  async (command) => {
    await using tmp = await tmpdir({ git: true })
    await Filesystem.write(path.join(tmp.path, "note.txt"), "KEEP")
    await Filesystem.write(path.join(tmp.path, "data.txt"), "B\nA\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await draftTurn(session.id)
        Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          void PermissionNext.reply({
            requestID: event.properties.id,
            reply: "once",
            decisionRevision: event.properties.decisionRevision,
          })
        })
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
        const ruleset = Loop.buildToolExecutionRuleset({
          agent: (await Agent.get("build"))!,
          session,
          permissionLevel: "ask",
        })
        const tool = await BashTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "",
          agent: "build",
          permissionLevel: "ask",
          abort: new AbortController().signal,
          messages: [],
          ruleset,
          metadata: async () => {},
          ask: (req: Parameters<Tool.Context["ask"]>[0]) =>
            PermissionNext.ask({ ...req, sessionID: session.id, ruleset }),
        } as Tool.Context
        await expect(tool.execute({ command, description: "Attempt a project write" }, ctx)).rejects.toThrow()
        expect(await Filesystem.readText(path.join(tmp.path, "note.txt"))).toBe("KEEP")
        expect(await Filesystem.isFile(path.join(tmp.path, "sorted.txt"))).toBe(false)
        expect(await PermissionNext.list()).toEqual([])
        const read = await tool.execute({ command: "cat note.txt", description: "Read a project file" }, ctx)
        expect(read.output).toContain("KEEP")
      },
    })
  },
)

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

test("ask rules require approval without treating the level as draft-only scope", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset = Loop.buildToolExecutionRuleset({
        agent: (await Agent.get("build"))!,
        session: await Session.create({}),
        permissionLevel: "ask",
      })
      for (const key of ["edit", "protected_write", "external_write", "bash", "bash_delete", "bash_risky"])
        expect(PermissionNext.evaluate(key, path.join(tmp.path, "src/foo.ts"), ruleset).action, key).toBe("ask")
      expect(PermissionNext.evaluate("bash_readonly", "git status", ruleset).action).toBe("ask")
      expect(PermissionNext.evaluate("read", path.join(tmp.path, "a.ts"), ruleset).action).toBe("ask")
    },
  })
})

test("every permission level exposes official plan tools without retired mode tools", async () => {
  await using tmp = await tmpdir({ git: true, config: { agent: { build: { deferTools: [] } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = (await Agent.get("build"))!
      const tools = async (session: Session.Info, permissionLevel: PermissionLevel.Value) => {
        const user = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          permissionLevel,
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: Date.now() },
        })
        const assistantInfo = (await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          parentID: user.id,
          time: { created: Date.now() },
        })) as Message.AssistantInfo
        const processor = SessionProcessor.create({
          assistantInfo,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })
        const result = await Loop.resolveTools({
          agent: build,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [{ info: user, parts: [] }],
          permissionLevel,
        })
        return Object.keys(result.tools).filter((key) => key.startsWith("plan_") || key === "question")
      }
      const main = await Session.create({})
      const expected = ["plan_edit", "plan_generate", "plan_read_chunk", "plan_simplify", "question"]
      for (const level of ["ask", "autoApprove", "fullTakeover"] as const) {
        await selectPermissionLevel({ sessionID: main.id, permissionLevel: level })
        expect((await tools(await Session.get(main.id), level)).sort()).toEqual(expected)
      }
      const child = await Session.create({ parentID: main.id })
      expect(await tools(child, "ask")).not.toContain("plan_exit")
    },
  })
})

test("draft-only scope blocks project edits while the dedicated plan tool still requires approval", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const draft = await draftTurn(session.id)
      const ruleset = Loop.buildToolExecutionRuleset({
        agent: (await Agent.get("build"))!,
        session,
        permissionLevel: "ask",
      })
      const ctx = {
        sessionID: session.id,
        messageID: draft.messageID,
        callID: "",
        agent: "build",
        permissionLevel: "ask" as const,
        kind: "ask" as const,
        abort: AbortSignal.any([]),
        messages: draft.messages,
        ruleset,
        metadata: async () => {},
        // Both draft-only constraints and approval use the real permission interface.
        ask: (req: Parameters<Tool.Context["ask"]>[0]) =>
          PermissionNext.askCurrent({ ...req, sessionID: session.id }, async () => ruleset),
      } as unknown as Tool.Context

      const target = path.join(tmp.path, "src", "foo.ts")
      const tool = await WriteTool.init()
      await expect(tool.execute({ filePath: target, content: "x" }, ctx)).rejects.toMatchObject({
        name: "TaskScopeDeniedError",
      })
      expect(await Filesystem.isFile(target)).toBe(false)

      const plan = Session.plan(session)
      await expect(tool.execute({ filePath: plan, content: "# plan\n" }, ctx)).rejects.toMatchObject({
        name: "PlanConflictError",
      })
      const off = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        void PermissionNext.reply({
          requestID: event.properties.id,
          reply: "once",
          decisionRevision: event.properties.decisionRevision,
        })
      })
      try {
        await (await PlanGenerateTool.init()).execute({ content: "# plan\n", expectedRevision: 0 }, ctx)
      } finally {
        off()
      }
      expect(await Filesystem.readText(plan)).toBe("# plan\n")
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})
