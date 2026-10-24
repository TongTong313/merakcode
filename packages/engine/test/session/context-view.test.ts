import { describe, expect, test } from "vitest"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Agent } from "@merakcode/engine/agent/agent"
import { Instance } from "@merakcode/engine/project/instance"
import type { Provider } from "@merakcode/engine/provider/provider"
import { Message } from "@merakcode/engine/session/message"
import { SessionContextBudget } from "@merakcode/engine/session/context-budget"
import { SessionContextView } from "@merakcode/engine/session/context-view"
import { SystemPrompt } from "@merakcode/engine/session/system"
import { Token } from "@merakcode/engine/util/token"
import { tmpdir } from "../fixture/fixture"

const sessionID = "session"

function createModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test Model",
    limit: {
      context: 128_000,
      input: 0,
      output: 8_192,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    api: { id: "test-model", npm: "@ai-sdk/anthropic", url: "https://example.com" },
    options: {},
    headers: {},
    status: "active",
  } as Provider.Model
}

function userInfo(id: string): Message.UserInfo {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
  } as Message.UserInfo
}

function assistantInfo(id: string, parentID: string): Message.AssistantInfo {
  return {
    id,
    sessionID,
    role: "assistant",
    parentID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test",
    finish: "stop",
    time: { created: 0 },
  } as Message.AssistantInfo
}

function text(messageID: string, id: string, value: string): Message.TextPart {
  return {
    id,
    messageID,
    sessionID,
    type: "text",
    text: value,
  }
}

function summaryInfo(id: string, parentID: string): Message.AssistantInfo {
  return {
    ...assistantInfo(id, parentID),
    mode: "compaction",
    agent: "compaction",
    summary: true,
  } as Message.AssistantInfo
}

function tool(messageID: string, id: string, callID: string, output: string): Message.ToolPart {
  return {
    id,
    messageID,
    sessionID,
    type: "tool",
    callID,
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output,
      title: "Bash",
      metadata: {},
      time: {
        start: 0,
        end: 0,
      },
    },
  }
}

describe("SessionContextView.build", () => {
  test("wraps queued user messages without mutating stored session messages", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const messages: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "initial request")] },
          { info: assistantInfo("msg_002", "msg_001"), parts: [text("msg_002", "part_002", "working")] },
          { info: userInfo("msg_003"), parts: [text("msg_003", "part_003", "queued update")] },
        ]

        const view = await SessionContextView.build({
          messages,
          sessionID,
          user: messages[2].info as Message.UserInfo,
          agent: {
            id: "build",
            mode: "primary",
            prompt: "Agent prompt",
          } as Agent.Info,
          model: createModel(),
          step: 2,
          lastFinishedID: "msg_002",
          extraSystem: ["extra structured-output instruction"],
        })

        expect((messages[2].parts[0] as Message.TextPart).text).toBe("queued update")
        expect((view.sessionMessages[0].parts[0] as Message.TextPart).text).toBe("initial request")
        expect((view.sessionMessages[2].parts[0] as Message.TextPart).text).toBe("queued update")
        expect((view.sessionMessages[2].parts[0] as Message.TextPart).text).not.toContain("<system-reminder>")
        expect(view.system[0]).toBe("Agent prompt")
        expect(view.system.join("\n")).toContain("extra structured-output instruction")
        expect(view.system.join("\n")).not.toContain("Working directory:")
        expect(JSON.stringify(view.messages[0])).toContain("current session and environment")
        expect(JSON.stringify(view.messages[0])).toContain("Working directory:")
        expect(SessionContextView.toRequestMessages({ system: view.system, messages: view.messages })[0]).toEqual({
          role: "system",
          content: "Agent prompt",
        })
        expect(view.tokens).toBe(view.stats.tokens.total)
        expect(view.stats.tokens.estimated).toBe(
          SessionContextView.estimate({ system: view.system, messages: view.messages }),
        )
        expect(JSON.stringify(view.messages.at(-1))).toContain("queued update")
      },
    })
  })

  test("includes transient extra messages without mutating session messages", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const messages: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "current request")] },
        ]
        const baseInput = {
          messages,
          sessionID,
          user: messages[0].info as Message.UserInfo,
          agent: {
            id: "build",
            mode: "primary",
            prompt: "Agent prompt",
          } as Agent.Info,
          model: createModel(),
          step: 1,
        }
        const extra = {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "<system-reminder>Skill hint</system-reminder>",
            },
          ],
        }

        const without = await SessionContextView.build(baseInput)
        const view = await SessionContextView.build({
          ...baseInput,
          extraMessages: [extra],
        })

        expect(JSON.stringify(view.messages)).toContain("Skill hint")
        expect(JSON.stringify(view.sessionMessages)).not.toContain("Skill hint")
        expect(view.stats.context.extraMessages).toBe(1)
        expect(view.stats.tokens.messages).toBeGreaterThan(without.stats.tokens.messages)
        expect(view.stats.tokens.estimated).toBe(
          SessionContextView.estimate({ system: view.system, messages: view.messages }),
        )
      },
    })
  })

  test("uses real usage plus new message and same-turn tool-result estimates for canonical tokens", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const output = "x".repeat(4_000)
        const assistant = {
          ...assistantInfo("msg_002", "msg_001"),
          tokens: {
            total: 20_000,
            input: 18_000,
            output: 2_000,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "tool-calls",
        } as Message.AssistantInfo
        const messages: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "initial request")] },
          { info: assistant, parts: [tool("msg_002", "part_002", "call_001", output)] },
          { info: userInfo("msg_003"), parts: [text("msg_003", "part_003", "new request")] },
        ]
        const model = createModel()
        const extra = {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "<system-reminder>Skill hint</system-reminder>",
            },
          ],
        }

        const view = await SessionContextView.build({
          messages,
          sessionID,
          user: messages[2].info as Message.UserInfo,
          agent: {
            id: "build",
            mode: "primary",
            prompt: "Agent prompt",
          } as Agent.Info,
          model,
          step: 1,
          extraMessages: [extra],
        })
        const delta =
          SessionContextView.estimate({
            system: [],
            messages: [extra, ...(await Message.toModelMessages([view.sessionMessages[2]], model))],
          }) + Token.estimate(output)

        expect(view.stats.canonical.source).toBe("usage+delta")
        expect(view.stats.canonical.baseline).toBe(20_000)
        expect(view.stats.canonical.estimatedDelta).toBe(delta)
        expect(view.stats.canonical.total).toBe(20_000 + delta)
        expect(view.stats.preflight.margin).toBe(2_000)
        expect(view.tokens).toBe(22_000 + delta)
      },
    })
  })

  test("applies tool-result budget to projected messages without mutating originals", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const oldOutput = `old-output-${"a".repeat(200_000)}`
        const messages: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "initial request")] },
          { info: assistantInfo("msg_002", "msg_001"), parts: [tool("msg_002", "part_002", "call_001", oldOutput)] },
          { info: userInfo("msg_003"), parts: [text("msg_003", "part_003", "follow-up")] },
          { info: assistantInfo("msg_004", "msg_003"), parts: [text("msg_004", "part_004", "working")] },
          { info: userInfo("msg_005"), parts: [text("msg_005", "part_005", "current request")] },
        ]

        const view = await SessionContextView.build({
          messages,
          sessionID,
          user: messages[4].info as Message.UserInfo,
          agent: {
            id: "build",
            mode: "primary",
            prompt: "Agent prompt",
          } as Agent.Info,
          model: createModel(),
          step: 1,
        })

        const original = messages[1].parts[0] as Message.ToolPart
        const projected = view.sessionMessages[1].parts[0] as Message.ToolPart

        expect(original.state.status === "completed" && original.state.output).toBe(oldOutput)
        expect(projected.state.status === "completed" && projected.state.output).toBe(
          SessionContextBudget.TOOL_RESULT_PLACEHOLDER,
        )
        expect(view.stats.toolResults.budgetCleared.count).toBe(1)
        expect(JSON.stringify(view.messages)).toContain(SessionContextBudget.TOOL_RESULT_PLACEHOLDER)
        expect(JSON.stringify(view.messages)).not.toContain("old-output-")
      },
    })
  })

  test("microcompacts older tool results by count", () => {
    const messages: Message.FullMsg[] = [
      {
        info: assistantInfo("msg_001", "msg_000"),
        parts: [
          tool("msg_001", "part_001", "call_001", "old one"),
          tool("msg_001", "part_002", "call_002", "old two"),
          tool("msg_001", "part_003", "call_003", "old three"),
          tool("msg_001", "part_004", "call_004", "old four"),
        ],
      },
    ]

    const stats = SessionContextBudget.applyToProjection({
      messages,
      budget: 1_000,
      recentTurns: 0,
      microcompactKeep: 2,
      microcompactTrigger: 3,
      now: 1,
    })

    expect(stats.microcompact.active).toBe(true)
    expect(stats.microcompactCleared.count).toBe(2)
    expect(((messages[0].parts[0] as Message.ToolPart).state as Message.ToolStateCompleted).output).toBe(
      SessionContextBudget.TOOL_RESULT_PLACEHOLDER,
    )
    expect(((messages[0].parts[3] as Message.ToolPart).state as Message.ToolStateCompleted).output).toBe("old four")
  })

  test("budgets only delta messages after the latest summary", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const oldOutput = `old-output-${"a".repeat(200_000)}`
        const messages: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "old request")] },
          { info: assistantInfo("msg_002", "msg_001"), parts: [tool("msg_002", "part_002", "call_001", oldOutput)] },
          {
            info: userInfo("msg_003"),
            parts: [
              {
                id: "part_003",
                messageID: "msg_003",
                sessionID,
                type: "compaction",
                auto: true,
              },
            ],
          },
          { info: summaryInfo("msg_004", "msg_003"), parts: [text("msg_004", "part_004", "old summary")] },
          { info: userInfo("msg_005"), parts: [text("msg_005", "part_005", "new request")] },
        ]

        const view = await SessionContextView.build({
          messages,
          sessionID,
          user: messages[4].info as Message.UserInfo,
          agent: {
            id: "build",
            mode: "primary",
            prompt: "Agent prompt",
          } as Agent.Info,
          model: createModel(),
          step: 1,
        })

        expect(view.stats.projected.messages).toBe(1)
        expect(view.stats.toolResults.original.count).toBe(0)
        const state = (view.sessionMessages[1].parts[0] as Message.ToolPart).state as Message.ToolStateCompleted
        expect(state.output).toBe(oldOutput)
        expect(JSON.stringify(view.messages)).toContain("<compaction-base>")
        expect(JSON.stringify(view.messages)).not.toContain("old-output-")
      },
    })
  })

  test("ignored context command messages are not sent back to the model", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const messages: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "real request")] },
          {
            info: assistantInfo("msg_002", "msg_001"),
            parts: [
              {
                ...text("msg_002", "part_002", "## 上下文报告\n\ndiagnostic only"),
                ignored: true,
              },
            ],
          },
          {
            info: userInfo("msg_003"),
            parts: [
              {
                ...text("msg_003", "part_003", "/context"),
                ignored: true,
              },
            ],
          },
          { info: userInfo("msg_004"), parts: [text("msg_004", "part_004", "next request")] },
        ]

        const view = await SessionContextView.build({
          messages,
          sessionID,
          user: messages[3].info as Message.UserInfo,
          agent: {
            id: "build",
            mode: "primary",
            prompt: "Agent prompt",
          } as Agent.Info,
          model: createModel(),
          step: 1,
        })

        const serialized = JSON.stringify(view.messages)
        expect(serialized).toContain("real request")
        expect(serialized).toContain("next request")
        expect(serialized).not.toContain("diagnostic only")
        expect(serialized).not.toContain("/context")
      },
    })
  })
})

test("git status comes after the history, so editing a file leaves everything before it as it was", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const messages: Message.FullMsg[] = [
        { info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "改一下 a.ts")] },
      ]
      const build = () =>
        SessionContextView.build({
          messages,
          sessionID,
          user: messages[0]!.info as Message.UserInfo,
          agent: { id: "build", mode: "primary", prompt: "Agent prompt" } as Agent.Info,
          model: createModel(),
          step: 1,
        })
      const before = await build()
      await writeFile(join(tmp.path, "a.ts"), "export const a = 1\n")
      const after = await build()
      expect(after.messages.slice(0, -1)).toEqual(before.messages.slice(0, -1))
      expect(JSON.stringify(after.messages[0])).not.toContain("<git-status>")
      expect(JSON.stringify(after.messages.at(-1))).toContain("?? a.ts")
    },
  })
})

test("the /context breakdown counts the context after the history as user context", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await writeFile(join(tmp.path, "a.ts"), "export const a = 1\n")
      const messages: Message.FullMsg[] = [{ info: userInfo("msg_001"), parts: [text("msg_001", "part_001", "hi")] }]
      const view = await SessionContextView.build({
        messages,
        sessionID,
        user: messages[0]!.info as Message.UserInfo,
        agent: { id: "build", mode: "primary", prompt: "Agent prompt" } as Agent.Info,
        model: createModel(),
        step: 1,
      })
      const tail = SessionContextView.toUserContextMessages(await SystemPrompt.gitStatus())
      expect(tail).toHaveLength(1)
      const reminders = [view.messages[0]!, ...tail]
      expect(view.stats.tokens.userContext).toBe(SessionContextView.estimate({ system: [], messages: reminders }))
    },
  })
})

describe("context that changes from step to step", () => {
  const agent = { id: "build", mode: "primary", prompt: "Agent prompt" } as Agent.Info
  const build = (messages: Message.FullMsg[], step: number) =>
    SessionContextView.build({
      messages,
      sessionID,
      user: messages[0]!.info as Message.UserInfo,
      agent,
      model: createModel(),
      step,
    })

  test("rides on the user's request, after its words, so the request is still the last user message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeFile(join(tmp.path, "a.ts"), "1")
        const view = await build([{ info: userInfo("msg_001"), parts: [text("msg_001", "p1", "改一下 a.ts")] }], 1)
        const last = view.messages.at(-1)!
        expect(last.role).toBe("user")
        const parts = last.content as { type: string; text: string }[]
        expect(parts[0]!.text).toBe("改一下 a.ts")
        expect(parts.at(-1)!.text).toContain("?? a.ts")
        expect(view.messages.filter((message) => message.role === "user")).toHaveLength(2)
      },
    })
  })

  test("the next step reuses everything up to the previous step's second-to-last message", async () => {
    // The previous step's last message carried the context and no longer does; everything before it is unchanged
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first: Message.FullMsg[] = [
          { info: userInfo("msg_001"), parts: [text("msg_001", "p1", "改一下 a.ts")] },
          { info: assistantInfo("msg_002", "msg_001"), parts: [tool("msg_002", "p2", "call_1", "read a.ts")] },
        ]
        const before = await build(first, 2)
        await writeFile(join(tmp.path, "a.ts"), "1")
        const after = await build(
          [...first, { info: assistantInfo("msg_003", "msg_001"), parts: [tool("msg_003", "p3", "call_2", "edited")] }],
          3,
        )
        const reused = before.messages.length - 1
        expect(after.messages.slice(0, reused)).toEqual(before.messages.slice(0, reused))
      },
    })
  })

  test("after a reply with no tool call it comes as a message of its own", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeFile(join(tmp.path, "a.ts"), "1")
        const view = await build(
          [
            { info: userInfo("msg_001"), parts: [text("msg_001", "p1", "你好")] },
            { info: assistantInfo("msg_002", "msg_001"), parts: [text("msg_002", "p2", "你好呀")] },
          ],
          2,
        )
        expect(JSON.stringify(view.messages.at(-2))).toContain("你好呀")
        expect(JSON.stringify(view.messages.at(-2))).not.toContain("?? a.ts")
        expect(view.messages.at(-1)!.role).toBe("user")
        expect(JSON.stringify(view.messages.at(-1))).toContain("?? a.ts")
      },
    })
  })

  test("a tool result with an attachment carries it as well", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeFile(join(tmp.path, "a.ts"), "1")
        const read = tool("msg_002", "p2", "call_1", "an image")
        if (read.state.status === "completed")
          read.state.attachments = [
            {
              id: "f1",
              sessionID,
              messageID: "msg_002",
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,AAAA",
            },
          ]
        const view = await build(
          [
            { info: userInfo("msg_001"), parts: [text("msg_001", "p1", "看图")] },
            { info: assistantInfo("msg_002", "msg_001"), parts: [read] },
          ],
          2,
        )
        const last = view.messages.at(-1)!
        expect(last.role).toBe("tool")
        const output = JSON.stringify((last.content as { output: unknown }[]).at(-1)!.output)
        expect(output).toContain("image/png")
        expect(output).toContain("?? a.ts")
      },
    })
  })

  test("a failed tool call carries it as well", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeFile(join(tmp.path, "a.ts"), "1")
        const failed = tool("msg_002", "p2", "call_1", "")
        failed.state = { status: "error", input: {}, error: "permission denied", time: { start: 0, end: 0 } }
        const view = await build(
          [
            { info: userInfo("msg_001"), parts: [text("msg_001", "p1", "改一下 a.ts")] },
            { info: assistantInfo("msg_002", "msg_001"), parts: [failed] },
          ],
          2,
        )
        const last = view.messages.at(-1)!
        expect(last.role).toBe("tool")
        const output = JSON.stringify((last.content as { output: unknown }[]).at(-1)!.output)
        expect(output).toContain("permission denied")
        expect(output).toContain("?? a.ts")
      },
    })
  })

  test("after a tool call it rides on the latest tool result, so no message is added after it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeFile(join(tmp.path, "a.ts"), "1")
        const view = await build(
          [
            { info: userInfo("msg_001"), parts: [text("msg_001", "p1", "改一下 a.ts")] },
            { info: assistantInfo("msg_002", "msg_001"), parts: [tool("msg_002", "p2", "call_1", "edited")] },
          ],
          2,
        )
        const last = view.messages.at(-1)!
        expect(last.role).toBe("tool")
        const output = JSON.stringify((last.content as { output: unknown }[]).at(-1)!.output)
        expect(output).toContain("edited")
        expect(output).toContain("?? a.ts")
      },
    })
  })
})
