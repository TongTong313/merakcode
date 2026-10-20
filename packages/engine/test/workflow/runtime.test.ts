import { describe, expect, test } from "vitest"
import z from "zod"
import { Bus } from "@merakcode/engine/bus/index"
import { Identifier } from "@merakcode/util/id"
import { Agent } from "@merakcode/engine/agent/agent"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { Message } from "@merakcode/engine/session/message"
import { SessionRunner } from "@merakcode/engine/session/runner"
import { ToolRegistry } from "@merakcode/engine/tool/registry"
import { WorkflowRuntime } from "@merakcode/engine/workflow/runtime"
import { WorkflowState } from "@merakcode/engine/workflow/state"
import type { WorkflowRunMetadata, WorkflowScript } from "@merakcode/engine/workflow/types"
import { tmpdir } from "../fixture/fixture"

function script(body: string, extra: Partial<WorkflowScript> = {}): WorkflowScript {
  return {
    name: "demo",
    description: "Demo",
    phases: [{ title: "Start" }, { title: "End" }],
    script: `export const meta = { name: 'demo', description: 'Demo' }\n${body}`,
    body,
    source: "custom",
    ...extra,
  }
}

function message(text: string): Message.FullMsg {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      role: "assistant",
      parentID: Identifier.ascending("message"),
      sessionID: "session-child",
      mode: "workflow-subagent",
      agent: "workflow-subagent",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [
      {
        id: Identifier.ascending("part"),
        sessionID: "session-child",
        messageID: id,
        type: "text",
        text,
      },
    ],
  }
}

describe("WorkflowRuntime", () => {
  test("runs phase, log, parallel, and pipeline without agents", async () => {
    const updates: WorkflowRunMetadata[] = []
    const result = await WorkflowRuntime.run({
      script: script(`
				await phase('End')
				await log('hello')
				const a = await parallel([() => 1, () => { throw new Error('x') }])
				const b = await pipeline([1, 2], value => value + 1, value => value * 2)
				return { a, b }
			`),
      args: {},
      sessionID: "session-test",
      messageID: "message-test",
      abort: new AbortController().signal,
      defaultModel: { providerID: "test", modelID: "test" },
      hooks: {
        update: async (metadata) => {
          updates.push(metadata)
        },
      },
    })

    expect(result.result).toEqual({ a: [1, null], b: [4, 6] })
    expect(updates.findLast((item) => item.status === "completed")?.phase).toBe("End")
    expect(updates.some((item) => item.logs.some((log) => log.message === "hello"))).toBe(true)
    expect(updates[0]?.maxConcurrentAgents).toBeUndefined()
  })

  test("uses a default phase when workflow metadata has no phases", async () => {
    const updates: WorkflowRunMetadata[] = []
    const result = await WorkflowRuntime.run({
      script: script(
        `
				await log('hello')
				return 'done'
			`,
        { phases: [] },
      ),
      args: {},
      sessionID: "session-test",
      messageID: "message-test",
      abort: new AbortController().signal,
      defaultModel: { providerID: "test", modelID: "test" },
      hooks: {
        update: async (metadata) => {
          updates.push(metadata)
        },
      },
    })

    expect(result.result).toBe("done")
    const final = updates.findLast((item) => item.status === "completed")
    expect(final?.phase).toBe("Workflow")
    expect(final?.phases).toEqual([{ title: "Workflow" }])
    expect(final?.logs[0]?.phase).toBe("Workflow")
  })

  test("marks workflow runs aborted when the abort signal is cancelled", async () => {
    const updates: WorkflowRunMetadata[] = []
    const controller = new AbortController()
    controller.abort()

    await expect(
      WorkflowRuntime.run({
        script: script("return 'done'"),
        args: {},
        sessionID: "session-test",
        messageID: "message-test",
        abort: controller.signal,
        defaultModel: { providerID: "test", modelID: "test" },
        hooks: {
          update: async (metadata) => {
            updates.push(metadata)
          },
        },
      }),
    ).rejects.toThrow()

    expect(updates[0]?.status).toBe("running")
    expect(updates.findLast((item) => item.status === "aborted")?.completedAt).toBeDefined()
  })

  test("uses workflow meta concurrency as a local agent queue", async () => {
    const updates: WorkflowRunMetadata[] = []
    const original = SessionRunner.prompt
    let running = 0
    let peak = 0
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      return message("done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script(
              `
								return await parallel([
									() => agent('one', { label: 'one' }),
									() => agent('two', { label: 'two' }),
									() => agent('three', { label: 'three' }),
								])
							`,
              { concurrency: 2, maxConcurrentAgents: 2 },
            ),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async (metadata) => {
                updates.push(metadata)
              },
            },
          }),
      })

      expect(result.result).toEqual(["done", "done", "done"])
      expect(peak).toBe(2)
      expect(updates.findLast((item) => item.status === "completed")?.maxConcurrentAgents).toBe(2)
      expect(updates.some((item) => item.queuedAgentCount === 1)).toBe(true)
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("fanout launches one agent per work unit and records units", async () => {
    const updates: WorkflowRunMetadata[] = []
    const original = SessionRunner.prompt
    let running = 0
    let peak = 0
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      return message(input.parts.find((part) => part.type === "text")?.text ?? "done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script(`
							await phase('Start')
							const units = [
								{ title: 'auth', description: 'scan auth', files: ['src/auth'], prompt: 'scan auth' },
								{ title: 'billing', description: 'scan billing', files: ['src/billing'], prompt: 'scan billing' },
							]
							return await fanout(units)
						`),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async (metadata) => {
                updates.push(metadata)
              },
            },
          }),
      })

      expect(result.result).toEqual(["scan auth", "scan billing"])
      expect(peak).toBe(2)
      const final = updates.findLast((item) => item.status === "completed")
      expect(final?.maxConcurrentAgents).toBe(2)
      expect(final?.workUnits?.map((unit) => [unit.title, unit.status, unit.agentId])).toEqual([
        ["auth", "completed", "agent-1"],
        ["billing", "completed", "agent-2"],
      ])
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("fanout keeps duplicate work unit ids unique", async () => {
    const updates: WorkflowRunMetadata[] = []
    const original = SessionRunner.prompt
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async () =>
      message("done")) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script(`
							return await fanout([
								{ id: 'same', title: 'one', prompt: 'one' },
								{ id: 'same', title: 'two', prompt: 'two' }
							])
						`),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async (metadata) => {
                updates.push(metadata)
              },
            },
          }),
      })

      const final = updates.findLast((item) => item.status === "completed")
      expect(final?.workUnits?.map((unit) => unit.id)).toEqual(["same", "same-2"])
      expect(final?.workUnits?.map((unit) => unit.agentId)).toEqual(["agent-1", "agent-2"])
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("fanout string results expose content/text/output aliases inside workflow scripts", async () => {
    const original = SessionRunner.prompt
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      return message(input.parts.find((part) => part.type === "text")?.text ?? "done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script(`
							const results = await fanout([{ title: 'structure', prompt: 'project structure ok' }])
							return {
								content: results[0]?.content || '无法获取项目结构信息',
								text: results[0]?.text,
								output: results[0]?.output,
								direct: String(results[0]),
							}
						`),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async () => {},
            },
          }),
      })

      expect(result.result).toEqual({
        content: "project structure ok",
        text: "project structure ok",
        output: "project structure ok",
        direct: "project structure ok",
      })
      expect(("host string" as unknown as { content?: string }).content).toBeUndefined()
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("workflow child sessions inherit caller rules while preserving workflow restrictions", async () => {
    const original = SessionRunner.prompt
    const captured: {
      kind?: SessionRunner.PromptInput["kind"]
      permission?: PermissionNext.Ruleset
      edit?: PermissionNext.Action
      externalDirectory?: PermissionNext.Action
      workflowRun?: PermissionNext.Action
      subagent?: PermissionNext.Action
    } = {}
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      const child = await Session.get(input.sessionID)
      const agent = await Agent.get("workflow-subagent")
      expect(agent).toBeDefined()
      const rules = SessionRunner.buildToolExecutionRuleset({
        agent: agent!,
        session: child,
        permissionMode: input.kind,
      })
      captured.kind = input.kind
      captured.permission = child.permission
      captured.edit = PermissionNext.evaluate("edit", "src/file.ts", rules).action
      captured.externalDirectory = PermissionNext.evaluate("external_directory", "D:/outside/*", rules).action
      captured.workflowRun = PermissionNext.evaluate("workflow_run", "demo", rules).action
      captured.subagent = PermissionNext.evaluate("subagent", "general", rules).action
      return message("done")
    }) as unknown as typeof SessionRunner.prompt

    const callerRuleset = PermissionNext.fromConfig({ "*": "allow" })

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script("return await agent('scan', { label: 'scan' })"),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset,
            hooks: {
              update: async () => {},
            },
          }),
      })

      expect(captured.kind).toBe("ask")
      expect(captured.permission).toEqual(callerRuleset)
      expect(captured.edit).toBe("allow")
      expect(captured.externalDirectory).toBe("allow")
      expect(captured.workflowRun).toBe("deny")
      expect(captured.subagent).toBe("deny")
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("workflow script kind option cannot elevate inherited non-auto rules", async () => {
    const original = SessionRunner.prompt
    const captured: {
      kind?: SessionRunner.PromptInput["kind"]
      edit?: PermissionNext.Action
      write?: PermissionNext.Action
    } = {}
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      const child = await Session.get(input.sessionID)
      const agent = await Agent.get("workflow-subagent")
      expect(agent).toBeDefined()
      const rules = SessionRunner.buildToolExecutionRuleset({
        agent: agent!,
        session: child,
        permissionMode: input.kind,
      })
      captured.kind = input.kind
      captured.edit = PermissionNext.evaluate("edit", "src/file.ts", rules).action
      captured.write = PermissionNext.evaluate("write", "src/file.ts", rules).action
      return message("done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script("return await agent('scan', { label: 'scan', kind: 'auto' })"),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset: PermissionNext.fromConfig({
              edit: "deny",
              write: "deny",
            }),
            hooks: {
              update: async () => {},
            },
          }),
      })

      expect(captured.kind).toBe("ask")
      expect(captured.edit).toBe("deny")
      expect(captured.write).toBe("deny")
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("workflow resume cache is scoped by inherited caller permissions", async () => {
    const original = SessionRunner.prompt
    let calls = 0
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async () => {
      calls++
      return message(`run-${calls}`)
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const scriptValue = script("return await agent('scan', { label: 'scan' })")
          const allow = PermissionNext.fromConfig({ "*": "allow" })
          const deny = PermissionNext.fromConfig({ edit: "deny" })

          const first = await WorkflowRuntime.run({
            runId: "resume-source",
            script: scriptValue,
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset: allow,
            hooks: {
              update: async () => {},
            },
          })
          expect(first.result).toBe("run-1")
          const resume = await WorkflowState.read("session-test", "resume-source")
          expect(resume).toBeDefined()

          const samePermission = await WorkflowRuntime.run({
            runId: "resume-same",
            script: scriptValue,
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset: allow,
            resume,
            hooks: {
              update: async () => {},
            },
          })
          expect(samePermission.result).toBe("run-1")
          expect(calls).toBe(1)

          const changedPermission = await WorkflowRuntime.run({
            runId: "resume-changed",
            script: scriptValue,
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset: deny,
            resume,
            hooks: {
              update: async () => {},
            },
          })
          expect(changedPermission.result).toBe("run-2")
          expect(calls).toBe(2)
        },
      })
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("workflow allowedTools narrows visible tools and child permissions", async () => {
    const original = SessionRunner.prompt
    const captured: {
      tools?: Record<string, boolean>
      permission?: PermissionNext.Ruleset
      read?: PermissionNext.Action
      edit?: PermissionNext.Action
      bash?: PermissionNext.Action
    } = {}
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      const child = await Session.get(input.sessionID)
      const agent = await Agent.get("workflow-subagent")
      expect(agent).toBeDefined()
      const rules = SessionRunner.buildToolExecutionRuleset({
        agent: agent!,
        session: child,
        permissionMode: input.kind,
      })
      captured.tools = input.tools
      captured.permission = child.permission
      captured.read = PermissionNext.evaluate("read", "*", rules).action
      captured.edit = PermissionNext.evaluate("edit", "*", rules).action
      captured.bash = PermissionNext.evaluate("bash", "*", rules).action
      return message("done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script("return await agent('scan', { label: 'scan', allowedTools: ['read', 'grep'] })"),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset: PermissionNext.fromConfig({ "*": "allow" }),
            hooks: {
              update: async () => {},
            },
          }),
      })

      expect(captured.tools?.read).toBeUndefined()
      expect(captured.tools?.grep).toBeUndefined()
      expect(captured.tools?.edit).toBe(false)
      expect(captured.tools?.bash).toBe(false)
      expect(captured.permission?.some((rule) => rule.permission === "edit" && rule.action === "deny")).toBe(true)
      expect(captured.permission?.some((rule) => rule.permission === "bash" && rule.action === "deny")).toBe(true)
      expect(captured.read).toBe("allow")
      expect(captured.edit).toBe("deny")
      expect(captured.bash).toBe("deny")
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("workflow allowedTools narrows custom tools from the target agent pool", async () => {
    const originalPrompt = SessionRunner.prompt
    const originalAgentGet = Agent.get
    const captured: {
      tools?: Record<string, boolean>
      custom?: PermissionNext.Action
    } = {}

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await ToolRegistry.register({
            id: "custom_lookup",
            init: async () => ({
              description: "Custom lookup",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }),
          })

          const base = await originalAgentGet("workflow-subagent")
          expect(base).toBeDefined()
          const custom: Agent.Info = {
            ...base!,
            id: "workflow-custom",
            name: "workflow-custom",
            profile: {
              ...(base!.profile ?? { kind: "ask" as const, availableTools: [], restrictedRules: [] }),
              availableTools: [...(base!.profile?.availableTools ?? []), "custom_lookup"],
            },
          }

          ;(Agent as unknown as { get: typeof Agent.get }).get = (async (id: string) =>
            id === "workflow-custom" ? custom : originalAgentGet(id)) as typeof Agent.get
          ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
            input: SessionRunner.PromptInput,
          ) => {
            const child = await Session.get(input.sessionID)
            const agent = await Agent.get(input.agent ?? "workflow-subagent")
            expect(agent).toBeDefined()
            const rules = SessionRunner.buildToolExecutionRuleset({
              agent: agent!,
              session: child,
              permissionMode: input.kind,
            })
            captured.tools = input.tools
            captured.custom = PermissionNext.evaluate("custom_lookup", "*", rules).action
            return message("done")
          }) as unknown as typeof SessionRunner.prompt

          await WorkflowRuntime.run({
            script: script("return await agent('scan', { agent: 'workflow-custom', allowedTools: ['read'] })"),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            callerRuleset: PermissionNext.fromConfig({ "*": "allow" }),
            hooks: {
              update: async () => {},
            },
          })
        },
      })

      expect(captured.tools?.custom_lookup).toBe(false)
      expect(captured.custom).toBe("deny")
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = originalPrompt
      ;(Agent as unknown as { get: typeof Agent.get }).get = originalAgentGet
    }
  })

  test("keeps agents grouped by the phase active when they are launched", async () => {
    const updates: WorkflowRunMetadata[] = []
    const original = SessionRunner.prompt
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      return message(input.parts.find((part) => part.type === "text")?.text ?? "done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script(`
							await phase('Start')
							const units = [
								{ title: 'source one', prompt: 'scan source one' },
								{ title: 'source two', prompt: 'scan source two' },
							]
							const findings = await fanout(units)
							await phase('End')
							return await agent('summarize ' + JSON.stringify(findings), { label: 'summary' })
						`),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async (metadata) => {
                updates.push(metadata)
              },
            },
          }),
      })

      const final = updates.findLast((item) => item.status === "completed")
      expect(final?.agents.map((agent) => [agent.label, agent.phase])).toEqual([
        ["source one", "Start"],
        ["source two", "Start"],
        ["summary", "End"],
      ])
      expect(final?.workUnits?.map((unit) => [unit.title, unit.phase, unit.agentId])).toEqual([
        ["source one", "Start", "agent-1"],
        ["source two", "Start", "agent-2"],
      ])
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("fanout records planned agent labels before children start", async () => {
    const updates: WorkflowRunMetadata[] = []
    const original = SessionRunner.prompt
    const gate = Promise.withResolvers<void>()
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async () => {
      await gate.promise
      return message("done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      const run = Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script(`
							await phase('Start')
							return await fanout(
								[{ title: 'auth', prompt: 'scan auth' }],
								(unit) => ({ label: 'review:' + unit.title, agentType: 'workflow-subagent' })
							)
						`),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async (metadata) => {
                updates.push(metadata)
              },
            },
          }),
      })

      // The gate keeps children from starting, so any match is the plan recorded before they start. Poll instead of
      // a fixed delay because script startup can take longer on a busy machine.
      const find = () => updates.find((item) => item.workUnits?.[0]?.agentLabel === "review:auth")
      for (let waited = 0; !find() && waited < 5000; waited += 10)
        await new Promise((resolve) => setTimeout(resolve, 10))
      const planned = find()
      expect(planned?.workUnits?.[0]).toMatchObject({
        title: "auth",
        agentLabel: "review:auth",
        agentType: "workflow-subagent",
        status: "queued",
      })
      gate.resolve()
      await run
    } finally {
      gate.resolve()
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("records the latest tool activity for each workflow agent", async () => {
    const updates: WorkflowRunMetadata[] = []
    const original = SessionRunner.prompt
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async (
      input: SessionRunner.PromptInput,
    ) => {
      const messageID = Identifier.ascending("message")
      await Bus.publish(Message.Event.PartUpdated, {
        part: {
          id: Identifier.ascending("part"),
          sessionID: input.sessionID,
          messageID,
          type: "tool",
          tool: "read",
          callID: "call-read",
          state: {
            status: "running",
            input: { filePath: "src/index.ts" },
            title: "Read src/index.ts",
            metadata: { filePath: "src/index.ts" },
            time: { start: Date.now() },
          },
        },
      })
      await Bus.publish(Message.Event.PartUpdated, {
        part: {
          id: Identifier.ascending("part"),
          sessionID: input.sessionID,
          messageID,
          type: "tool",
          tool: "grep",
          callID: "call-grep",
          state: {
            status: "completed",
            input: { pattern: "workflow" },
            output: "src/workflow/runtime.ts: agent()",
            title: "Search workflow",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        },
      })
      return message("done")
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          WorkflowRuntime.run({
            script: script("return await agent('scan', { label: 'scan' })"),
            args: {},
            sessionID: "session-test",
            messageID: "message-test",
            abort: new AbortController().signal,
            defaultModel: { providerID: "test", modelID: "test" },
            hooks: {
              update: async (metadata) => {
                updates.push(metadata)
              },
            },
          }),
      })

      const final = updates.findLast((item) => item.status === "completed")
      expect(final?.agents[0]?.latestTool).toMatchObject({
        tool: "grep",
        callID: "call-grep",
        status: "completed",
        title: "Search workflow",
        summary: "src/workflow/runtime.ts: agent()",
      })
      expect(final?.agents[0]?.toolCount).toBe(2)
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })

  test("does not expose host runtime through built-in constructors", async () => {
    const updates: WorkflowRunMetadata[] = []

    await expect(
      WorkflowRuntime.run({
        script: script("return Object.constructor('return process')()"),
        args: {},
        sessionID: "session-test",
        messageID: "message-test",
        abort: new AbortController().signal,
        defaultModel: { providerID: "test", modelID: "test" },
        hooks: {
          update: async (metadata) => {
            updates.push(metadata)
          },
        },
      }),
    ).rejects.toThrow()

    expect(updates.findLast((item) => item.status === "failed")?.error).toBeTruthy()
  })
})

// When a child agent is asked for structured output and produces none, agent() must mark it failed and throw. Falling
// back to text or an empty string and marking it completed made workflows succeed with empty results.
describe("WorkflowRuntime schema failures are not silently downgraded", () => {
  test("resolveAgentOutput returns the text when no schema is requested", () => {
    expect(
      WorkflowRuntime.resolveAgentOutput({
        schemaRequested: false,
        role: "assistant",
        structured: undefined,
        text: "hi",
        error: undefined,
      }),
    ).toEqual({ ok: true, output: "hi" })
  })

  test("resolveAgentOutput returns the structured object when a schema is requested and produced", () => {
    expect(
      WorkflowRuntime.resolveAgentOutput({
        schemaRequested: true,
        role: "assistant",
        structured: { a: 1 },
        text: "",
        error: undefined,
      }),
    ).toEqual({ ok: true, output: { a: 1 } })
  })

  test("resolveAgentOutput fails instead of falling back to text when structured output is missing", () => {
    const r = WorkflowRuntime.resolveAgentOutput({
      schemaRequested: true,
      role: "assistant",
      structured: undefined,
      text: "def bubble(arr): ...",
      error: new Message.StructuredOutputError({
        message: "Model did not produce structured output",
        retries: 2,
      }).toObject(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/structured/i)
  })

  test("agent({ schema }) marks the agent failed and fails the workflow when no structured output is produced", async () => {
    const original = SessionRunner.prompt
    ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = (async () => {
      const msg = message("def bubble(arr): ...") // plain text, no structured output
      ;(msg.info as { error?: unknown }).error = new Message.StructuredOutputError({
        message: "Model did not produce structured output",
        retries: 2,
      }).toObject()
      return msg
    }) as unknown as typeof SessionRunner.prompt

    try {
      await using tmp = await tmpdir()
      const updates: WorkflowRunMetadata[] = []
      await expect(
        Instance.provide({
          directory: tmp.path,
          fn: async () =>
            WorkflowRuntime.run({
              script: script(
                `return await agent('impl', { schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } })`,
              ),
              args: {},
              sessionID: "session-test",
              messageID: "message-test",
              abort: new AbortController().signal,
              defaultModel: { providerID: "test", modelID: "test" },
              hooks: {
                update: async (metadata) => {
                  updates.push(metadata)
                },
              },
            }),
        }),
      ).rejects.toThrow()

      const failedAgent = updates.flatMap((item) => item.agents).findLast((agent) => agent.status === "failed")
      expect(failedAgent).toBeDefined()
      expect(failedAgent?.error ?? "").toMatch(/structured/i)
    } finally {
      ;(SessionRunner as unknown as { prompt: typeof SessionRunner.prompt }).prompt = original
    }
  })
})
