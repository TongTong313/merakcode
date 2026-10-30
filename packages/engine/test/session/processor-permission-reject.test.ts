/**
 * Partial rejection of parallel tool calls: the processor stops only when every tool in the stream was rejected.
 */
import { afterEach, test, expect } from "vitest"
import { rm } from "node:fs/promises"
import type { Provider } from "@merakcode/engine/agent/model/provider"
import { Agent } from "@merakcode/engine/agent/agent"
import { Session } from "@merakcode/engine/agent/session/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/agent/session/message"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Log } from "@merakcode/log/logger"
import { LLM } from "@merakcode/engine/agent/model/llm"

Log.init({ print: false })

const stream = LLM.stream

function mockModel() {
  return {
    id: "gpt-4",
    providerID: "openai",
    modelID: "gpt-4",
    api: { id: "gpt-4" },
  } as unknown as Provider.Model
}

async function runProcessor(continueOnDeny?: boolean) {
  const { SessionProcessor } = await import("@merakcode/engine/agent/loop/processor")
  await using tmp = await tmpdir({
    git: true,
    config: continueOnDeny === undefined ? undefined : { experimental: { continue_loop_on_deny: continueOnDeny } },
    dispose: (dir) => rm(dir, { recursive: true, force: true }),
  })
  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const sessionID = session.id

      const user = await Session.updateInfo({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })

      const assistantInfo: Message.AssistantInfo = {
        id: Identifier.ascending("message"),
        role: "assistant",
        sessionID,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-4",
        providerID: "openai",
        parentID: user.id,
        time: { created: Date.now() },
      }
      await Session.updateInfo(assistantInfo)

      const model = mockModel()
      const proc = SessionProcessor.create({
        assistantInfo,
        sessionID,
        model,
        abort: new AbortController().signal,
      })
      const agent = await Agent.get("build")
      expect(agent).toBeDefined()

      const result = await proc.process({
        user: user as Message.UserInfo,
        agent: agent!,
        abort: new AbortController().signal,
        sessionID,
        system: [],
        messages: [],
        tools: {},
        model,
      })
      return {
        result,
        parts: await Message.parts({ sessionID: assistantInfo.sessionID, messageID: assistantInfo.id }),
      }
    },
  })
}

afterEach(() => {
  LLM.stream = stream
})

test("process returns continue when only some tools are rejected", async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        const ok = { filePath: "/a.txt", content: "ok" }
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: "tc1", toolName: "write" }
        yield { type: "tool-input-end", id: "tc1" }
        yield { type: "tool-call", toolCallId: "tc1", toolName: "write", input: ok }
        yield {
          type: "tool-result",
          toolCallId: "tc1",
          input: ok,
          output: { output: "done", metadata: {}, title: "Write a.txt" },
        }
        yield { type: "tool-input-start", id: "tc2", toolName: "write" }
        yield { type: "tool-input-end", id: "tc2" }
        yield { type: "tool-call", toolCallId: "tc2", toolName: "write", input: ok }
        yield { type: "tool-error", toolCallId: "tc2", input: ok, error: new PermissionNext.RejectedError() }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

  const run = await runProcessor()
  expect(run.result).toBe("continue")
  const denied = run.parts.find((part): part is Message.ToolPart => part.type === "tool" && part.callID === "tc2")
  expect(denied?.state.status).toBe("error")
  if (denied?.state.status !== "error") throw new Error("rejected tool part was not persisted as an error")
  expect(denied.state.metadata).toEqual({ errorKind: "permission_rejected" })
})

test("process returns stop when every tool is rejected", async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        const ok = { filePath: "/a.txt", content: "x" }
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: "tc1", toolName: "write" }
        yield { type: "tool-input-end", id: "tc1" }
        yield { type: "tool-call", toolCallId: "tc1", toolName: "write", input: ok }
        yield { type: "tool-error", toolCallId: "tc1", input: ok, error: new PermissionNext.RejectedError() }
        yield { type: "tool-input-start", id: "tc2", toolName: "write" }
        yield { type: "tool-input-end", id: "tc2" }
        yield { type: "tool-call", toolCallId: "tc2", toolName: "write", input: ok }
        yield { type: "tool-error", toolCallId: "tc2", input: ok, error: new PermissionNext.RejectedError() }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

  const run = await runProcessor()
  expect(run.result).toBe("stop")
})

for (const [success, continueOnDeny, expected] of [
  [false, undefined, "stop"],
  [false, false, "stop"],
  [true, undefined, "continue"],
  [false, true, "continue"],
] as const) {
  test(`stop condition after rejection: success=${success}, continue=${continueOnDeny}`, async () => {
    LLM.stream = async () =>
      ({
        stream: (async function* () {
          yield { type: "start-step" }
          if (success) {
            yield { type: "tool-input-start", id: "ok", toolName: "read" }
            yield { type: "tool-input-end", id: "ok" }
            yield { type: "tool-call", toolCallId: "ok", toolName: "read", input: {} }
            yield {
              type: "tool-result",
              toolCallId: "ok",
              input: {},
              output: { title: "", output: "done", metadata: {} },
            }
          }
          yield { type: "tool-input-start", id: "denied", toolName: "write" }
          yield { type: "tool-input-end", id: "denied" }
          yield { type: "tool-call", toolCallId: "denied", toolName: "write", input: {} }
          yield { type: "tool-error", toolCallId: "denied", input: {}, error: new PermissionNext.RejectedError() }
        })(),
      }) as unknown as Awaited<ReturnType<typeof LLM.stream>>
    const run = await runProcessor(continueOnDeny)
    expect(run.result).toBe(expected)
    const denied = run.parts.find((part): part is Message.ToolPart => part.type === "tool" && part.callID === "denied")
    if (denied?.state.status !== "error") throw new Error("denial was not persisted")
    expect(denied.state.metadata).toEqual({ errorKind: "permission_rejected" })
  })
}

test("process continues to the next turn when CorrectedError carries user feedback", async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        const input = { command: "cat package.json" }
        yield { type: "start-step" }
        yield { type: "tool-input-start", id: "feedback", toolName: "bash" }
        yield { type: "tool-input-end", id: "feedback" }
        yield { type: "tool-call", toolCallId: "feedback", toolName: "bash", input }
        yield {
          type: "tool-error",
          toolCallId: "feedback",
          input,
          error: new PermissionNext.CorrectedError("不要使用 cat，改用 read 工具"),
        }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

  const run = await runProcessor()
  expect(run.result).toBe("continue")
  const feedback = run.parts.find(
    (part): part is Message.ToolPart => part.type === "tool" && part.callID === "feedback",
  )
  expect(feedback?.state.status).toBe("error")
  if (feedback?.state.status !== "error") throw new Error("feedback tool part was not persisted as an error")
  expect(feedback.state.error).toContain("不要使用 cat，改用 read 工具")
})

test("terminal tool errors distinguish timeout from execution failure", async () => {
  LLM.stream = async () =>
    ({
      stream: (async function* () {
        for (const [id, error] of [
          ["timeout", new Error("Operation timed out after 30000ms")],
          ["execution", new Error("tool crashed")],
        ] as const) {
          yield { type: "tool-input-start", id, toolName: "write" }
          yield { type: "tool-input-end", id }
          yield { type: "tool-call", toolCallId: id, toolName: "write", input: {} }
          yield { type: "tool-error", toolCallId: id, input: {}, error }
        }
      })(),
    }) as unknown as Awaited<ReturnType<typeof LLM.stream>>

  const run = await runProcessor()
  const errors = run.parts.flatMap((part) => {
    if (part.type !== "tool" || part.state.status !== "error") return []
    return [[part.callID, part.state.metadata?.errorKind]]
  })
  expect(errors).toEqual([
    ["timeout", "timeout"],
    ["execution", "execution"],
  ])
})
