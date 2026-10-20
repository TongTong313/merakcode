// End-to-end behavior of resolveTools is covered in apps/cli/test/session/runner-deferred-tools.test.ts.
import { describe, expect, test } from "vitest"
import { computeDeferred, DEFAULT_DEFERRED_TOOLS, STANDARD_TOOL_POOL, type Agent } from "./agent"

/** Minimal Agent.Info: computeDeferred only reads profile.availableTools / profile.deferTools */
function makeAgent(availableTools: string[], deferTools?: string[]): Agent.Info {
  return {
    id: "test",
    name: "test",
    mode: "primary",
    permission: [],
    options: {},
    profile: {
      availableTools,
      restrictedRules: [],
      ...(deferTools !== undefined ? { deferTools } : {}),
    },
  } as unknown as Agent.Info
}

describe("computeDeferred", () => {
  test("falls back to DEFAULT_DEFERRED_TOOLS without deferTools", () => {
    const agent = makeAgent([...STANDARD_TOOL_POOL])
    expect(computeDeferred(agent)).toEqual(new Set(DEFAULT_DEFERRED_TOOLS))
  })

  test("an explicit [] disables deferred loading, unlike undefined", () => {
    const agent = makeAgent([...STANDARD_TOOL_POOL], [])
    expect(computeDeferred(agent)).toEqual(new Set())
  })

  test("custom deferTools contain only the given tools", () => {
    const agent = makeAgent([...STANDARD_TOOL_POOL], ["pdf_parse"])
    expect(computeDeferred(agent)).toEqual(new Set(["pdf_parse"]))
  })

  test("tools removed by disableTools (not in availableTools) are not deferred", () => {
    // As after disableTools=["pdf_parse"]
    const agent = makeAgent(STANDARD_TOOL_POOL.filter((t) => t !== "pdf_parse"))
    const result = computeDeferred(agent)
    expect(result.has("pdf_parse")).toBe(false)
    expect(result.has("excel_parse")).toBe(true)
  })

  test("deferTools outside availableTools are filtered out", () => {
    const agent = makeAgent(["read", "pdf_parse"], ["pdf_parse", "excel_parse"])
    expect(computeDeferred(agent)).toEqual(new Set(["pdf_parse"]))
  })

  test("bash_background is deferred by default for the main session", () => {
    // It must be in STANDARD_TOOL_POOL (visible to the main agent, so computeDeferred keeps it) and in
    // DEFAULT_DEFERRED_TOOLS. Subagent pools exclude it explicitly (POOL_EXPLORE, ...) and are not checked here.
    expect(STANDARD_TOOL_POOL).toContain("bash_background")
    expect(DEFAULT_DEFERRED_TOOLS).toContain("bash_background")
    const agent = makeAgent([...STANDARD_TOOL_POOL])
    expect(computeDeferred(agent).has("bash_background")).toBe(true)
  })
})
