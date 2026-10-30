import { describe, expect, test } from "vitest"
import { Loop } from "@merakcode/engine/agent/loop/index"
import type { Message } from "@merakcode/engine/agent/session/message"

const assistant = (finish: Message.AssistantInfo["finish"], error?: Message.AssistantInfo["error"]) =>
  ({
    id: "msg_assistant",
    sessionID: "ses_test",
    role: "assistant",
    parentID: "msg_user",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "model",
    providerID: "provider",
    finish,
    error,
    time: { created: Date.now() },
  }) satisfies Message.AssistantInfo

const textPart = (text: string) =>
  ({
    id: "part_text",
    messageID: "msg_assistant",
    sessionID: "ses_test",
    type: "text",
    text,
  }) satisfies Message.TextPart

const toolPart = {
  id: "part_tool",
  messageID: "msg_assistant",
  sessionID: "ses_test",
  type: "tool",
  tool: "bash",
  callID: "call_test",
  state: {
    status: "completed",
    input: {},
    output: "ok",
    title: "bash",
    metadata: {},
    time: { start: Date.now(), end: Date.now() },
  },
} satisfies Message.ToolPart

describe("Loop.shouldStopUnknownFinish", () => {
  test("treats unknown finish as stop when the assistant produced text without tools", () => {
    expect(
      Loop.shouldStopUnknownFinish({
        assistant: assistant("unknown"),
        parts: [textPart("你好，有什么可以帮你？")],
      }),
    ).toBe(true)
  })

  test("does not stop unknown finish when a tool was used", () => {
    expect(
      Loop.shouldStopUnknownFinish({
        assistant: assistant("unknown"),
        parts: [textPart("我来检查一下。"), toolPart],
      }),
    ).toBe(false)
  })

  test("does not stop unknown finish for empty text or errors", () => {
    expect(
      Loop.shouldStopUnknownFinish({
        assistant: assistant("unknown"),
        parts: [textPart("   ")],
      }),
    ).toBe(false)

    expect(
      Loop.shouldStopUnknownFinish({
        assistant: assistant("unknown", { name: "UnknownError", data: { message: "failed" } }),
        parts: [textPart("partial answer")],
      }),
    ).toBe(false)
  })

  test("keeps standard stop handling outside the unknown-finish fallback", () => {
    expect(
      Loop.shouldStopUnknownFinish({
        assistant: assistant("stop"),
        parts: [textPart("done")],
      }),
    ).toBe(false)
  })
})
