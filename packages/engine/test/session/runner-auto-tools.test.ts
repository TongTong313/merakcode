import { test, expect } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "@merakcode/engine/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { SessionProcessor } from "@merakcode/engine/session/processor"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import type { Provider } from "@merakcode/engine/provider/provider"
import { ToolRegistry } from "@merakcode/engine/tool/registry"
import z from "zod"

test("resolveTools drops question and plan mode tools in auto mode, and also subagent in child sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const sessionID = session.id
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        permissionMode: "auto",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      // tsc rejects casting a minimal stub straight to Provider.Model; going through unknown marks it as a stub.
      const model = {
        id: "gpt-4",
        providerID: "openai",
        modelID: "gpt-4",
        api: { id: "gpt-4" },
      } as unknown as Provider.Model
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
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
        sessionID,
        model,
        abort: new AbortController().signal,
      })

      const { tools: toolsMain } = await SessionRunner.resolveTools({
        agent: agent!,
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
        permissionMode: "auto",
      })
      // Auto mode never interrupts the user: no question and no plan_enter (plan mode needs human approval); outside
      // plan mode there is no plan_exit either.
      expect(toolsMain.question).toBeUndefined()
      expect(toolsMain.plan_enter).toBeUndefined()
      expect(toolsMain.plan_exit).toBeUndefined()
      expect(toolsMain.subagent).toBeDefined()
      // workflow_run is deferred by default and becomes available the turn after tool_search activates it.
      expect(toolsMain.workflow_run).toBeUndefined()
      expect(toolsMain.pdf_parse).toBeUndefined()
      expect(toolsMain.tool_search).toBeDefined()

      const { tools: toolsSub } = await SessionRunner.resolveTools({
        agent: agent!,
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
        permissionMode: "auto",
        child: true,
      })
      expect(toolsSub.subagent).toBeUndefined()
      expect(toolsSub.workflow_run).toBeUndefined()
      // Child sessions still get tool_search for other deferred tools such as pdf_parse, without workflow_run.
      expect(toolsSub.tool_search).toBeDefined()
    },
  })
})

test("resolveTools respects per-message standard tool disables", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const sessionID = session.id
      const disabledTools = {
        read: false,
        skill: false,
      }
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        tools: disabledTools,
        time: { created: Date.now() },
      })
      const model = {
        id: "gpt-4",
        providerID: "openai",
        modelID: "gpt-4",
        api: { id: "gpt-4" },
      } as unknown as Provider.Model
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
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
        sessionID,
        model,
        abort: new AbortController().signal,
      })
      const { tools } = await SessionRunner.resolveTools({
        agent: agent!,
        model,
        session,
        tools: disabledTools,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
      })

      expect(tools.read).toBeUndefined()
      expect(tools.skill).toBeUndefined()
      expect(tools.grep).toBeDefined()
    },
  })
})

test("resolveTools exposes dynamic plugin tools to primary agents but not explore agents", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ToolRegistry.register({
        id: "plugin_smoke",
        init: async () => ({
          description: "runtime plugin tool",
          parameters: z.object({}),
          execute: async () => ({ title: "", metadata: {}, output: "ok" }),
        }),
      })

      const session = await Session.create({})
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const model = {
        id: "gpt-4",
        providerID: "openai",
        modelID: "gpt-4",
        api: { id: "gpt-4" },
      } as unknown as Provider.Model
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
      const build = await Agent.get("build")
      const explore = await Agent.get("explore")
      expect(build).toBeDefined()
      expect(explore).toBeDefined()

      const base = {
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
      }
      const { tools: buildTools } = await SessionRunner.resolveTools({ ...base, agent: build! })
      const { tools: exploreTools } = await SessionRunner.resolveTools({ ...base, agent: explore! })
      const { tools: disabledTools } = await SessionRunner.resolveTools({
        ...base,
        agent: build!,
        tools: { plugin_smoke: false },
      })

      expect(buildTools.plugin_smoke).toBeDefined()
      expect(exploreTools.plugin_smoke).toBeUndefined()
      expect(disabledTools.plugin_smoke).toBeUndefined()
    },
  })
})

test("resolveTools drops subagent for sessions with a parentID, even outside auto mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const session = await Session.create({ parentID: parent.id })
      const sessionID = session.id
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      const model = {
        id: "gpt-4",
        providerID: "openai",
        modelID: "gpt-4",
        api: { id: "gpt-4" },
      } as unknown as Provider.Model
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()
      const assistantInfo = (await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
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
        sessionID,
        model,
        abort: new AbortController().signal,
      })
      const { tools } = await SessionRunner.resolveTools({
        agent: agent!,
        model,
        session,
        processor,
        bypassAgentCheck: false,
        messages: [{ info: user, parts: [] }],
      })
      expect(tools.subagent).toBeUndefined()
      expect(tools.workflow_run).toBeUndefined()
    },
  })
})
