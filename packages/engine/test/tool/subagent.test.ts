import { test, expect } from "vitest"
import z from "zod"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Agent } from "@merakcode/engine/agent/agent"
import { Identifier } from "@merakcode/util/id"
import { Session } from "@merakcode/engine/agent/session/index"
import { Message } from "@merakcode/engine/agent/session/message"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { SubAgentTool, summarizeSubagentMetrics } from "@merakcode/engine/agent/tools/subagent"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { tmpdir } from "../fixture/fixture"

test("starting a subagent asks in ask mode, is allowed in auto mode and is denied inside a child session", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = (await Agent.get("build"))!
      const session = await Session.create({})
      const child = await Session.create({ parentID: session.id })
      const decide = (target: Session.Info, permissionMode: "ask" | "auto") =>
        PermissionNext.evaluate(
          "subagent",
          "explore",
          Loop.buildToolExecutionRuleset({ agent: build, session: target, permissionMode }),
        ).action
      expect(decide(session, "ask")).toBe("ask")
      expect(decide(session, "auto")).toBe("allow")
      expect(decide(child, "auto")).toBe("deny")
    },
  })
})

test("SubAgentTool description omits hidden subagents by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      const tool = await SubAgentTool.init({ agent: build })
      expect(tool.description).toContain("general")
      expect(tool.description).not.toContain("workflow-subagent")
    },
  })
})

const validSubagentInput = {
  description: "Inspect auth flow",
  prompt: "Use medium search depth and summarize the auth flow.",
  subagent_type: "explore",
}

test("SubAgentTool reports measured task metadata from all model steps", () => {
  const metrics = summarizeSubagentMetrics({
    taskID: "task-1",
    messages: [
      {
        info: {
          id: "message-1",
          role: "assistant",
          sessionID: "task-1",
          time: { created: 1000, completed: 2500 },
          tokens: { total: 20, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "step-1",
            messageID: "message-1",
            sessionID: "task-1",
            type: "step-finish",
            reason: "tool-calls",
            cost: 0,
            tokens: { total: 20, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          {
            id: "step-2",
            messageID: "message-1",
            sessionID: "task-1",
            type: "step-finish",
            reason: "stop",
            cost: 0,
            tokens: { total: 30, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
      } as unknown as Message.FullMsg,
    ],
  })

  expect(metrics).toEqual({
    source: "merakcode-subagent",
    task_id: "task-1",
    message_ids: ["message-1"],
    total_tokens: 50,
    duration_ms: 1500,
  })
})

test("SubAgentTool mode stays optional in JSON Schema and limited to context inheritance values", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await SubAgentTool.init()
      const schema = z.toJSONSchema(tool.parameters) as {
        required?: string[]
        properties?: Record<string, { default?: string; description?: string; enum?: string[] }>
      }

      expect(schema.required ?? []).not.toContain("mode")
      expect(schema.properties?.mode?.enum).toEqual(["fresh", "fork"])
      expect(schema.properties?.mode?.default).toBe("fresh")
      expect(schema.properties?.mode?.description).toContain("does not control task thoroughness")
      expect(schema.properties?.prompt?.description).toContain("Thoroughness: medium")
      expect(tool.description).toContain("The optional `mode` field only controls context inheritance")
      expect(tool.description).toContain("Thoroughness: medium")

      const explore = await Agent.get("explore")
      expect(explore?.description).toContain("subagent prompt")
      expect(explore?.description).toContain('mode only accepts "fresh" or "fork"')
      expect(explore?.prompt).toContain("search thoroughness level in the task prompt")
    },
  })
})

test("SubAgentTool accepts omitted, fresh, and fork modes while defaulting omission to fresh", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await SubAgentTool.init()

      expect(tool.parameters.parse(validSubagentInput).mode).toBe("fresh")
      expect(tool.parameters.parse({ ...validSubagentInput, mode: "fresh" }).mode).toBe("fresh")
      expect(tool.parameters.parse({ ...validSubagentInput, mode: "fork" }).mode).toBe("fork")
    },
  })
})

test("SubAgentTool rejects search thoroughness in mode with a corrective error", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await SubAgentTool.init()
      const invalid = { ...validSubagentInput, mode: "medium" }

      expect(tool.parameters.safeParse(invalid).success).toBe(false)

      try {
        await tool.execute(invalid as never, undefined as unknown as Tool.Context)
        throw new Error("expected invalid subagent mode to be rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        const message = (error as Error).message.toLowerCase()
        expect(message).toContain("mode")
        expect(message).toContain("fresh")
        expect(message).toContain("fork")
        expect(message).toContain("prompt")
        expect(message).toContain("medium")
      }

      try {
        await tool.execute(
          { prompt: validSubagentInput.prompt, subagent_type: "explore", mode: "medium" } as never,
          undefined as unknown as Tool.Context,
        )
        throw new Error("expected mixed invalid subagent input to be rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        const message = (error as Error).message.toLowerCase()
        expect(message).toContain("description")
        expect(message).toContain("mode")
        expect(message).toContain("prompt")
      }
    },
  })
})

test("SubAgentTool formatValidationError adds the mode hint only for invalid mode values", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await SubAgentTool.init()
      expect(tool.formatValidationError).toBeDefined()

      // Only mode is invalid (search thoroughness passed as mode): the base message gets the mode hint
      const modeErr = tool.parameters.safeParse({ ...validSubagentInput, mode: "medium" }).error!
      const modeMsg = tool.formatValidationError!(modeErr)
      expect(modeMsg).toContain('The "mode" argument only controls context inheritance')
      expect(modeMsg).toContain("fresh")
      expect(modeMsg).toContain("fork")
      expect(modeMsg).toContain("prompt")
      expect(modeMsg.toLowerCase()).toContain("medium")

      // Other errors (missing description) return only the base message
      const descErr = tool.parameters.safeParse({
        prompt: validSubagentInput.prompt,
        subagent_type: "explore",
      }).error!
      expect(descErr).toBeDefined()
      const descMsg = tool.formatValidationError!(descErr)
      expect(descMsg).toContain("invalid arguments")
      expect(descMsg).not.toContain('The "mode" argument only controls context inheritance')
    },
  })
})

test("SubAgentTool routes omitted mode, fork, and task_id without changing their precedence", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({})
      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: parent.id,
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        time: { created: Date.now() },
      })
      const assistant = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID: parent.id,
        parentID: user.id,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model",
        providerID: "test",
        time: { created: Date.now() },
      })
      const ctx = {
        sessionID: parent.id,
        messageID: assistant.id,
        callID: "call_subagent_route",
        agent: "build",
        kind: "ask" as const,
        abort: new AbortController().signal,
        extra: { bypassAgentCheck: true },
        messages: [],
        ruleset: [],
        metadata: async () => {},
        ask: async () => {},
      } satisfies Tool.Context

      const calls: Loop.PromptInput[] = []
      const originalPrompt = Loop.prompt
      ;(Loop as unknown as { prompt: typeof Loop.prompt }).prompt = (async (input) => {
        calls.push(input)
        const created = Date.now() - 1000
        return {
          info: {
            id: "msg_subagent_prompt_stub",
            role: "assistant",
            sessionID: input.sessionID,
            time: { created, completed: created + 1000 },
            tokens: { total: 10, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: "part_subagent_prompt_stub",
              messageID: "msg_subagent_prompt_stub",
              sessionID: input.sessionID,
              type: "text",
              text: "done",
            },
            {
              id: "part_subagent_finish_stub",
              messageID: "msg_subagent_prompt_stub",
              sessionID: input.sessionID,
              type: "step-finish",
              reason: "stop",
              cost: 0,
              tokens: { total: 10, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        } as unknown as Message.FullMsg
      }) as typeof Loop.prompt

      try {
        const tool = await SubAgentTool.init()

        const freshResult = await tool.execute(validSubagentInput, ctx)
        expect(calls.at(-1)?.sessionID).toBe(freshResult.metadata.sessionId)
        expect(freshResult.metadata.totalTokens).toBe(10)
        expect(freshResult.metadata.durationMs).toBe(1000)
        expect(freshResult.output).toContain("<task_metadata>")
        expect(freshResult.output).toContain('"task_id":')
        expect(freshResult.output).toContain('"message_ids":["msg_subagent_prompt_stub"]')
        expect(freshResult.output).not.toContain('"total_tokens"')
        expect(freshResult.output).not.toContain('"duration_ms"')
        expect((await Session.get(freshResult.metadata.sessionId)).parentID).toBe(parent.id)
        expect(await Session.messages({ sessionID: freshResult.metadata.sessionId })).toHaveLength(0)

        const forkResult = await tool.execute({ ...validSubagentInput, mode: "fork" }, ctx)
        expect(calls.at(-1)?.sessionID).toBe(forkResult.metadata.sessionId)
        expect((await Session.get(forkResult.metadata.sessionId)).parentID).toBe(parent.id)
        const forkMessages = await Session.messages({ sessionID: forkResult.metadata.sessionId })
        expect(forkMessages).toHaveLength(1)
        expect(forkMessages[0].info.role).toBe("user")

        const resumable = await Session.create({ parentID: parent.id, title: "resumable child" })
        const childrenBeforeResume = await Session.children(parent.id)
        const resumeResult = await tool.execute({ ...validSubagentInput, task_id: resumable.id, mode: "fork" }, ctx)
        expect(resumeResult.metadata.sessionId).toBe(resumable.id)
        expect(calls.at(-1)?.sessionID).toBe(resumable.id)
        expect(await Session.children(parent.id)).toHaveLength(childrenBeforeResume.length)
      } finally {
        ;(Loop as unknown as { prompt: typeof Loop.prompt }).prompt = originalPrompt
      }
    },
  })
})
