import { describe, expect, test } from "vitest"
import { persistToolResult } from "../loop/processor"

describe("persistToolResult", () => {
  test("invalid tool results are stored as errors and not counted as successes", () => {
    const result = persistToolResult({
      tool: "invalid",
      input: { tool: "write", error: "JSON parsing failed" },
      output: "The arguments provided to the tool are invalid: JSON parsing failed",
      title: "Invalid Tool",
      metadata: { invalid: true, intendedTool: "write" },
      start: 10,
      end: 20,
    })
    expect(result.countSuccess).toBe(false)
    expect(result.state).toEqual({
      status: "error",
      input: { tool: "write", error: "JSON parsing failed" },
      error: "The arguments provided to the tool are invalid: JSON parsing failed",
      metadata: {
        invalid: true,
        intendedTool: "write",
        errorKind: "invalid_arguments",
      },
      time: { start: 10, end: 20 },
    })
  })

  test("a normal write is stored as completed and counted as a success", () => {
    const result = persistToolResult({
      tool: "write",
      input: { filePath: "/a.py", content: "print(1)" },
      output: "wrote",
      title: "Write a.py",
      metadata: {},
      start: 1,
      end: 2,
    })
    expect(result.countSuccess).toBe(true)
    expect(result.state.status).toBe("completed")
    if (result.state.status !== "completed") throw new Error("expected completed")
    expect(result.state.output).toBe("wrote")
  })
})
