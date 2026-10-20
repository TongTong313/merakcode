import { describe, expect, test } from "vitest"
import type { AssistantMessage, Session, UserMessage } from "@merakcode/sdk/client"
import {
  assistantMessageTokens,
  assistantModelName,
  resolveSessionUsage,
  sessionRoundCostTotal,
  visibleMessages,
} from "../../src/cli/cmd/tui/routes/session/session-usage"

function assistant(partial: Partial<AssistantMessage> & Pick<AssistantMessage, "id" | "cost">): AssistantMessage {
  return {
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "msg_user",
    modelID: "deepseek-r1",
    providerID: "alibaba",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    finish: "stop",
    tokens: {
      input: 24000,
      output: 100,
      reasoning: 50,
      cache: { read: 0, write: 0 },
    },
    ...partial,
  }
}

function user(id: string): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "alibaba", modelID: "deepseek-r1" },
  }
}

describe("session-usage", () => {
  test("assistantModelName uses the model's display name (alibaba-cn ids differ a lot) and falls back to the raw id", () => {
    const providers = [
      { id: "alibaba-cn", models: { "GLM-5.2-W4A8_sort20260709184007406": { name: "GLM-5.2_P800" } } },
    ] as any
    expect(
      assistantModelName({ providerID: "alibaba-cn", modelID: "GLM-5.2-W4A8_sort20260709184007406" }, providers),
    ).toBe("GLM-5.2_P800")
    expect(assistantModelName({ providerID: "alibaba-cn", modelID: "removed_sort1" }, providers)).toBe("removed_sort1")
    expect(assistantModelName({ providerID: "gone", modelID: "m" }, providers)).toBe("m")
  })

  test("visibleMessages filters out messages hidden by undo", () => {
    const session = {
      undoRedo: { stack: [{ hiddenMessages: ["msg_a2"] }] },
    } as Session
    const messages = [
      user("msg_u1"),
      assistant({ id: "msg_a1", cost: 0.01, parentID: "msg_u1" }),
      assistant({ id: "msg_a2", cost: 0.02, parentID: "msg_u1" }),
    ]
    expect(visibleMessages(messages, session).map((m) => m.id)).toEqual(["msg_u1", "msg_a1"])
  })

  test("sessionRoundCostTotal sums the cost of visible, finished rounds", () => {
    const messages = [
      assistant({ id: "msg_a1", cost: 0.01 }),
      assistant({ id: "msg_a2", cost: 0.01 }),
      assistant({ id: "msg_a3", cost: 0, finish: "tool-calls" }),
    ]
    expect(sessionRoundCostTotal(messages, undefined)).toBeCloseTo(0.02)
  })

  test("assistantMessageTokens matches the main page formula", () => {
    const tokens = assistantMessageTokens(
      assistant({
        id: "msg_a1",
        cost: 0,
        tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      }),
    )
    expect(tokens).toBe(24)
  })

  test("resolveSessionUsage takes the sidebar context from the last assistant message with output", () => {
    const providers = [
      {
        id: "alibaba",
        models: {
          "deepseek-r1": { limit: { context: 128000 } },
        },
      },
    ] as any
    const messages = [
      assistant({
        id: "msg_a1",
        cost: 0.01,
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      assistant({
        id: "msg_a2",
        cost: 0.01,
        tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]
    const usage = resolveSessionUsage({ messages, session: undefined, providers })
    expect(usage.cost).toBeCloseTo(0.02)
    expect(usage.context?.tokens).toBe(210)
    expect(usage.context?.percentage).toBe(0)
  })
})
