import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import { QuestionTool } from "@merakcode/engine/agent/tools/question"
import * as QuestionModule from "@merakcode/engine/agent/session/question/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "ses_test",
  messageID: "test-message",
  callID: "test-call",
  agent: "test-agent",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
  askExternalDirectory: async () => {},
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    askSpy = vi.spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    await using dir = await tmpdir()
    const result = await Instance.provide({ directory: dir.path, fn: () => tool.execute({ questions }, ctx) })
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    await using dir = await tmpdir()
    const result = await Instance.provide({ directory: dir.path, fn: () => tool.execute({ questions }, ctx) })
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })
})
