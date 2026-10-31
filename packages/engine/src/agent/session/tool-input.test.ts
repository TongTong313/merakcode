import { describe, expect, test } from "vitest"
import { Message } from "./message"
import { SessionContextBudget } from "../context/context-budget"
import { SessionToolInput } from "./tool-input"

const sessionID = "test-session"

function toolPart(msgID: string, id: string, tool: string, input: Record<string, unknown>): Message.ToolPart {
  return {
    id,
    messageID: msgID,
    sessionID,
    type: "tool",
    callID: `call-${id}`,
    tool,
    state: {
      status: "completed",
      input,
      output: "ok",
      title: tool,
      metadata: {},
      time: { start: 0, end: 0 },
    },
  } as Message.ToolPart
}

function assistantMsg(id: string, parts: Message.Part[]): Message.FullMsg {
  return {
    info: { id, sessionID, role: "assistant", agent: "build", mode: "build", time: { created: 0 } },
    parts,
  } as unknown as Message.FullMsg
}

// Trailing user turns push earlier assistant messages out of the protected window (recentTurns=2 needs 2+ turns).
function users(count: number): Message.FullMsg[] {
  return Array.from({ length: count }, (_, i) => ({
    info: {
      id: `u${i}`,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "t", modelID: "t" },
    },
    parts: [{ id: `ut${i}`, messageID: `u${i}`, sessionID, type: "text" as const, text: "go" }],
  })) as Message.FullMsg[]
}

describe("SessionToolInput", () => {
  test("truncate shortens long content and keeps filePath", () => {
    const part = toolPart("m1", "p1", "write", { filePath: "/a.ts", content: "x".repeat(10_000) })
    const changed = SessionToolInput.truncate(part, 4_000)
    expect(changed).toBe(true)
    const input = part.state.input as { filePath: string; content: string }
    expect(input.filePath).toBe("/a.ts")
    expect(input.content.length).toBeLessThan(4_100)
    expect(input.content).toContain("[... content truncated")
  })

  test("short content is not truncated", () => {
    const part = toolPart("m1", "p1", "write", { filePath: "/a.ts", content: "short" })
    const changed = SessionToolInput.truncate(part, 4_000)
    expect(changed).toBe(false)
    expect((part.state.input as { content: string }).content).toBe("short")
  })

  test("edit truncates oldString and newString and keeps filePath", () => {
    const part = toolPart("m1", "p1", "edit", {
      filePath: "/a.ts",
      oldString: "o".repeat(5_000),
      newString: "n".repeat(5_000),
    })
    SessionToolInput.truncate(part, 4_000)
    const input = part.state.input as { filePath: string; oldString: string; newString: string }
    expect(input.filePath).toBe("/a.ts")
    expect(input.oldString).toContain("[... content truncated")
    expect(input.newString).toContain("[... content truncated")
  })

  test("multi_edit truncates each item of the edits array", () => {
    const part = toolPart("m1", "p1", "multi_edit", {
      filePath: "/a.ts",
      edits: [{ oldString: "a", newString: "B".repeat(5_000) }],
    })
    SessionToolInput.truncate(part, 4_000)
    const edits = (part.state.input as { edits: { newString: string }[] }).edits
    expect(edits[0].newString).toContain("[... content truncated")
  })

  test("tools without content fields (read/bash) are not truncated", () => {
    const part = toolPart("m1", "p1", "read", { filePath: "/a.ts" })
    expect(SessionToolInput.isTruncatable("read")).toBe(false)
    expect(SessionToolInput.truncate(part, 4_000)).toBe(false)
  })
})

describe("SessionContextBudget.applyToProjection input budget", () => {
  test("truncates write content over the input budget", () => {
    // Two old writes, followed by 3 user turns that move them out of the protected window
    const messages = [
      assistantMsg("a0", [toolPart("m0", "p0", "write", { filePath: "/a.ts", content: "A".repeat(10_000) })]),
      assistantMsg("a1", [toolPart("m1", "p1", "write", { filePath: "/b.ts", content: "B".repeat(10_000) })]),
      ...users(3),
    ]
    const stats = SessionContextBudget.applyToProjection({
      messages,
      recentTurns: 2,
      inputBudget: 4_000, // fits only one write input
      inputMaxChars: 4_000,
    })
    expect(stats.input.enabled).toBe(true)
    expect(stats.input.truncated.count).toBeGreaterThan(0)
    // Candidates are visited newest first, so the budget goes to a1 and the older a0 is truncated.
    const truncated = messages[0].parts[0] as Message.ToolPart
    expect((truncated.state.input as { content: string }).content).toContain("[... content truncated")
    const kept = messages[1].parts[0] as Message.ToolPart
    expect((kept.state.input as { content: string }).content.length).toBe(10_000)
  })

  test("does not truncate when the input budget is 0", () => {
    const messages = [
      assistantMsg("a0", [toolPart("m0", "p0", "write", { filePath: "/a.ts", content: "A".repeat(10_000) })]),
      ...users(3),
    ]
    const stats = SessionContextBudget.applyToProjection({ messages, recentTurns: 2, inputBudget: 0 })
    expect(stats.input.enabled).toBe(false)
    const kept = messages[0].parts[0] as Message.ToolPart
    expect((kept.state.input as { content: string }).content.length).toBe(10_000)
  })

  test("does not truncate write inputs inside the protected window", () => {
    // Only one user turn after the write, so it stays inside the window (1 < 2)
    const messages = [
      assistantMsg("a0", [toolPart("m0", "p0", "write", { filePath: "/a.ts", content: "A".repeat(10_000) })]),
      ...users(1),
    ]
    const stats = SessionContextBudget.applyToProjection({
      messages,
      recentTurns: 2,
      inputBudget: 1,
      inputMaxChars: 4_000,
    })
    expect(stats.input.truncated.count).toBe(0)
    const kept = messages[0].parts[0] as Message.ToolPart
    expect((kept.state.input as { content: string }).content.length).toBe(10_000)
  })

  test("resolves the dynamic budget as clamp(usable * share, min, max)", () => {
    // default share is 0.1
    expect(SessionContextBudget.resolveInputBudgetConfig(100_000, undefined)).toEqual({
      enabled: true,
      budget: 10_000,
      maxCharsPerField: 4_000,
    })
    // large windows are capped at max
    expect(SessionContextBudget.resolveInputBudgetConfig(500_000, undefined).budget).toBe(20_000)
    // small windows get at least min
    expect(SessionContextBudget.resolveInputBudgetConfig(1_000, undefined).budget).toBe(4_000)
    expect(SessionContextBudget.resolveInputBudgetConfig(100_000, false).enabled).toBe(false)
    // custom share: 50k * 0.3 = 15k, within [min, max]
    expect(SessionContextBudget.resolveInputBudgetConfig(50_000, { share: 0.3, max_chars_per_field: 8_000 })).toEqual({
      enabled: true,
      budget: 15_000,
      maxCharsPerField: 8_000,
    })
  })
})
