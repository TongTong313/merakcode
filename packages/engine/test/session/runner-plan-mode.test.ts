/**
 * Plan mode is read-only mode with the same rule chain. The tools change with the mode: plan mode has only plan_exit,
 * ask mode only plan_enter, and auto mode neither (it never switches into a mode that needs human approval); child
 * sessions have neither.
 */
import { test, expect } from "vitest"
import path from "path"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Identifier } from "@merakcode/util/id"
import { SessionProcessor } from "@merakcode/engine/session/processor"
import { Message } from "@merakcode/engine/session/message"
import { WriteTool } from "@merakcode/engine/tool/write"
import type { Tool } from "@merakcode/engine/tool/tool"
import type { Provider } from "@merakcode/engine/provider/provider"
import type { PermissionMode } from "@merakcode/engine/permission/mode"
import { Filesystem } from "@merakcode/util/filesystem"

const model = {
  id: "gpt-4",
  providerID: "openai",
  modelID: "gpt-4",
  api: { id: "gpt-4" },
} as unknown as Provider.Model

test("plan mode blocks file edits and non-read-only commands but allows reads and read-only commands", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset = SessionRunner.buildToolExecutionRuleset({
        agent: (await Agent.get("build"))!,
        session: await Session.create({}),
        permissionMode: "readonly",
      })
      for (const key of ["edit", "protected_write", "external_write", "bash", "bash_delete", "bash_risky"])
        expect(PermissionNext.evaluate(key, path.join(tmp.path, "src/foo.ts"), ruleset).action, key).toBe("deny")
      expect(PermissionNext.evaluate("bash_readonly", "git status", ruleset).action).toBe("allow")
      expect(PermissionNext.evaluate("read", path.join(tmp.path, "a.ts"), ruleset).action).toBe("allow")
    },
  })
})

test("resolveTools offers plan_enter or plan_exit by mode, and neither in auto mode or child sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = (await Agent.get("build"))!
      const tools = async (session: Session.Info, permissionMode: PermissionMode.Value) => {
        const user = await Session.updateInfo({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          permissionMode,
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
        const result = await SessionRunner.resolveTools({
          agent: build,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [{ info: user, parts: [] }],
          permissionMode,
        })
        return Object.keys(result.tools).filter(
          (key) => key === "plan_enter" || key === "plan_exit" || key === "question",
        )
      }
      const main = await Session.create({})
      expect((await tools(main, "readonly")).sort()).toEqual(["plan_exit", "question"])
      expect((await tools(main, "ask")).sort()).toEqual(["plan_enter", "question"])
      expect(await tools(main, "auto")).toEqual([])
      const child = await Session.create({ parentID: main.id })
      expect(await tools(child, "readonly")).not.toContain("plan_exit")
    },
  })
})

test("in plan mode WriteTool points project file writes to plan_exit, but writes the plan file without approval", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const ruleset = SessionRunner.buildToolExecutionRuleset({
        agent: (await Agent.get("build"))!,
        session,
        permissionMode: "readonly",
      })
      const ctx = {
        sessionID: session.id,
        messageID: "",
        callID: "",
        agent: "build",
        permissionMode: "readonly" as const,
        kind: "readonly" as const,
        abort: AbortSignal.any([]),
        messages: [],
        ruleset,
        metadata: async () => {},
        // Real approval center: a denial throws, and an ask would hang (it must not happen here).
        ask: (req: Parameters<Tool.Context["ask"]>[0]) =>
          PermissionNext.ask({ ...req, sessionID: session.id, ruleset }),
      } as unknown as Tool.Context

      const target = path.join(tmp.path, "src", "foo.ts")
      const tool = await WriteTool.init()
      await expect(tool.execute({ filePath: target, content: "x" }, ctx)).rejects.toThrow(/plan_exit/)
      expect(await Filesystem.isFile(target)).toBe(false)

      const plan = Session.plan(session)
      await tool.execute({ filePath: plan, content: "# plan\n" }, ctx)
      expect(await Filesystem.readText(plan)).toBe("# plan\n")
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})
