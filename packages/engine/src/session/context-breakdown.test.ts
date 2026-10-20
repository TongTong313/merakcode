import { describe, expect, test } from "vitest"
import { ContextBreakdown } from "./context-breakdown"

const empty: ContextBreakdown.Sources = {
  systemBase: "",
  environment: [],
  rules: [],
  tools: {},
  mcpToolIds: new Set<string>(),
  messages: [],
}

describe("ContextBreakdown.compute", () => {
  test("empty sources give zero for every part", () => {
    expect(ContextBreakdown.compute(empty)).toEqual({
      systemBase: 0,
      environment: 0,
      rules: 0,
      toolDefinitions: 0,
      mcp: 0,
      skills: 0,
      subagents: 0,
      conversation: 0,
      total: 0,
    })
  })

  test("systemBase counts the string length", () => {
    const r = ContextBreakdown.compute({ ...empty, systemBase: "hello" })
    expect(r.systemBase).toBe(5)
    expect(r.total).toBe(5)
  })

  test("environment and rules count the length after joining with \\n", () => {
    const r = ContextBreakdown.compute({ ...empty, environment: ["ab", "cd"], rules: ["xyz"] })
    expect(r.environment).toBe(5) // "ab\ncd"
    expect(r.rules).toBe(3)
    expect(r.total).toBe(8)
  })

  test("tools are grouped by id into mcp, skill, subagent and builtin, counting description + schema + key", () => {
    const tools = {
      read: { description: "d", schema: { a: 1 } },
      mcp__x: { description: "", schema: {} },
      skill: { description: "sk", schema: {} },
      subagent: { description: "su", schema: {} },
    }
    const r = ContextBreakdown.compute({ ...empty, tools, mcpToolIds: new Set(["mcp__x"]) })
    expect(r.toolDefinitions).toBe(1 + JSON.stringify({ a: 1 }).length + "read".length)
    expect(r.mcp).toBe(0 + JSON.stringify({}).length + "mcp__x".length)
    expect(r.skills).toBe("sk".length + JSON.stringify({}).length + "skill".length)
    expect(r.subagents).toBe("su".length + JSON.stringify({}).length + "subagent".length)
  })

  test("synthetic tools _noop, invalid and StructuredOutput are not counted", () => {
    const tools = {
      _noop: { description: "x", schema: { a: 1 } },
      invalid: { description: "x", schema: { a: 1 } },
      StructuredOutput: { description: "x", schema: { a: 1 } },
    }
    const r = ContextBreakdown.compute({ ...empty, tools })
    expect(r.toolDefinitions).toBe(0)
    expect(r.total).toBe(0)
  })

  test("conversation = JSON.stringify(messages).length", () => {
    const messages = [{ role: "user", content: "hi" }]
    const r = ContextBreakdown.compute({ ...empty, messages })
    expect(r.conversation).toBe(JSON.stringify(messages).length)
  })

  test("total is the sum of all parts", () => {
    const r = ContextBreakdown.compute({
      systemBase: "abc",
      environment: ["de"],
      rules: ["fghi"],
      tools: { read: { description: "d", schema: {} } },
      mcpToolIds: new Set<string>(),
      messages: [1],
    })
    expect(r.total).toBe(
      r.systemBase + r.environment + r.rules + r.toolDefinitions + r.mcp + r.skills + r.subagents + r.conversation,
    )
  })

  test("a missing description counts as 0 without throwing", () => {
    const r = ContextBreakdown.compute({ ...empty, tools: { read: { schema: {} } } })
    expect(r.toolDefinitions).toBe(JSON.stringify({}).length + "read".length)
  })
})
