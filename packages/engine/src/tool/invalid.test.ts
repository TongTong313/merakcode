import { describe, expect, test } from "vitest"
import { InvalidTool } from "./invalid"
import type { Tool } from "./tool"

const ctx = {
  sessionID: "s",
  messageID: "m",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  ruleset: [],
  metadata() {},
  ask: async () => {},
  askExternalDirectory: async () => {},
} as unknown as Tool.Context

describe("InvalidTool.execute", () => {
  test("explains the error to the model in English and includes intendedTool for the UI", async () => {
    const tool = await InvalidTool.init()
    const result = await tool.execute({ tool: "write", error: "JSON parsing failed" }, ctx)
    expect(result.output).toBe("The arguments provided to the tool are invalid: JSON parsing failed")
    expect(result.metadata).toMatchObject({ invalid: true, intendedTool: "write" })
  })
})
