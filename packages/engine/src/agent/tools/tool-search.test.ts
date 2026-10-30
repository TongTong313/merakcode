import { describe, expect, test } from "vitest"
import {
  autoActivationMetadata,
  buildDeferredPlan,
  buildToolSearchTool,
  scanActivatedTools,
  ACTIVATION_IDLE_TURNS,
  type DeferredToolSummary,
} from "./tool-search"
import type { Message } from "../session/message"

const deferred: DeferredToolSummary[] = [
  { id: "pdf_parse", summary: "Parse and extract content from PDF files." },
  { id: "excel_parse", summary: "Read and analyze Excel workbooks." },
  { id: "workflow_run", summary: "Execute a workflow script orchestrating child agents." },
]

function completedToolPart(
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
) {
  return {
    type: "tool" as const,
    callID: "c1",
    tool,
    state: { status: "completed" as const, input, output: "", title: "", metadata, time: { start: 0, end: 0 } },
  }
}

/** scanActivatedTools only reads part.type/tool/state, so info is a minimal stub. */
function makeMessages(parts: unknown[]): Message.FullMsg[] {
  return [{ info: { id: "m1", role: "user" }, parts }] as unknown as Message.FullMsg[]
}

function compactionPart(preCompactActivatedTools: string[]) {
  return {
    type: "compaction" as const,
    auto: true,
    preCompactActivatedTools,
  }
}

/** An empty user message advances the turn count used for idle tracking. */
function userMessage(id = "u") {
  return { info: { id, role: "user" as const }, parts: [] }
}

function assistantMessage(parts: unknown[], id = "a") {
  return { info: { id, role: "assistant" as const }, parts }
}

/** A direct call to the tool (not through tool_search), which restarts its idle count. */
function realToolCallPart(tool: string) {
  return {
    type: "tool" as const,
    callID: "c_real",
    tool,
    state: { status: "completed" as const, input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 0 } },
  }
}

describe("scanActivatedTools", () => {
  test("recovers activations from tool_search calls via metadata.activatedTool", () => {
    const messages = makeMessages([
      completedToolPart("tool_search", { name: "pdf_parse" }, { activatedTool: "pdf_parse" }),
    ])
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse"]))
  })

  test("falls back to input.name when metadata is missing", () => {
    const messages = makeMessages([completedToolPart("tool_search", { name: "excel_parse" }, undefined)])
    expect(scanActivatedTools(messages)).toEqual(new Set(["excel_parse"]))
  })

  test("ignores unfinished calls and calls to other tools", () => {
    const messages = makeMessages([
      completedToolPart("skill", { name: "pdf" }, { name: "pdf" }),
      {
        type: "tool",
        callID: "c2",
        tool: "tool_search",
        state: {
          status: "pending",
          input: { name: "workflow_run" },
          output: "",
          title: "",
          time: { start: 0, end: 0 },
        },
      },
    ])
    expect(scanActivatedTools(messages)).toEqual(new Set())
  })

  test("returns an empty set for empty history", () => {
    expect(scanActivatedTools([])).toEqual(new Set())
  })

  test("accumulates activations without duplicates", () => {
    const messages = makeMessages([
      completedToolPart("tool_search", { name: "pdf_parse" }, { activatedTool: "pdf_parse" }),
      completedToolPart("tool_search", { name: "excel_parse" }, { activatedTool: "excel_parse" }),
    ])
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse", "excel_parse"]))
  })

  test("restores activations carried by a compaction boundary", () => {
    const messages = makeMessages([compactionPart(["pdf_parse", "excel_parse"])])
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse", "excel_parse"]))
  })

  test("merges a compaction boundary with later tool_search calls", () => {
    const messages = makeMessages([
      compactionPart(["pdf_parse"]),
      completedToolPart("tool_search", { name: "excel_parse" }, { activatedTool: "excel_parse" }),
    ])
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse", "excel_parse"]))
  })

  test("drops a tool unused for more than ACTIVATION_IDLE_TURNS turns", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage([completedToolPart("tool_search", { name: "pdf_parse" }, { activatedTool: "pdf_parse" })]),
      ...Array.from({ length: ACTIVATION_IDLE_TURNS + 1 }, (_, i) => userMessage(`u${i + 2}`)),
    ] as unknown as Message.FullMsg[]
    expect(scanActivatedTools(messages)).toEqual(new Set())
  })

  test("keeps a tool idle for exactly ACTIVATION_IDLE_TURNS turns", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage([completedToolPart("tool_search", { name: "pdf_parse" }, { activatedTool: "pdf_parse" })]),
      ...Array.from({ length: ACTIVATION_IDLE_TURNS }, (_, i) => userMessage(`u${i + 2}`)),
    ] as unknown as Message.FullMsg[]
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse"]))
  })

  test("counts an automatic activation record as an activation", () => {
    const messages = makeMessages([
      { type: "text", text: "", synthetic: true, ignored: true, metadata: autoActivationMetadata(["workflow_run"]) },
    ])
    expect(scanActivatedTools(messages)).toEqual(new Set(["workflow_run"]))
  })

  test("ignores a plain text part without activation metadata", () => {
    const messages = makeMessages([{ type: "text", text: "帮我用 workflow 调研" }])
    expect(scanActivatedTools(messages)).toEqual(new Set())
  })

  test("restores every tool in metadata.activatedTools", () => {
    const messages = makeMessages([
      completedToolPart(
        "tool_search",
        { name: "pdf_parse,excel_parse" },
        { activatedTools: ["pdf_parse", "excel_parse"] },
      ),
    ])
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse", "excel_parse"]))
  })

  test("treats an empty activatedTools array as final without falling back to input.name", () => {
    // The model named an already loaded tool; execute recorded an empty array, so bash must not count as activated.
    const messages = makeMessages([completedToolPart("tool_search", { name: "bash" }, { activatedTools: [] })])
    expect(scanActivatedTools(messages)).toEqual(new Set())
  })

  test("splits input.name on commas when metadata is missing", () => {
    const messages = makeMessages([completedToolPart("tool_search", { name: "pdf_parse, excel_parse" }, undefined)])
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse", "excel_parse"]))
  })

  test("a direct call to the tool restarts its idle count", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage([completedToolPart("tool_search", { name: "pdf_parse" }, { activatedTool: "pdf_parse" })]),
      ...Array.from({ length: ACTIVATION_IDLE_TURNS - 1 }, (_, i) => userMessage(`u${i + 2}`)),
      assistantMessage([realToolCallPart("pdf_parse")], "a2"),
      ...Array.from({ length: ACTIVATION_IDLE_TURNS - 1 }, (_, i) => userMessage(`u${i + 2 + ACTIVATION_IDLE_TURNS}`)),
    ] as unknown as Message.FullMsg[]
    expect(scanActivatedTools(messages)).toEqual(new Set(["pdf_parse"]))
  })
})

describe("buildToolSearchTool", () => {
  test("description lists the inactive tools", () => {
    const t = buildToolSearchTool({ deferred, activated: new Set() })
    expect(t.description).toContain("<deferred_tools>")
    expect(t.description).toContain('name="pdf_parse"')
    expect(t.description).toContain("excel_parse")
  })

  test("hides activated tools from the list", () => {
    const t = buildToolSearchTool({ deferred, activated: new Set(["pdf_parse"]) })
    expect(t.description).not.toContain('name="pdf_parse"')
    expect(t.description).toContain("excel_parse")
  })

  test("description says so when every tool is activated", () => {
    const t = buildToolSearchTool({
      deferred,
      activated: new Set(["pdf_parse", "excel_parse", "workflow_run"]),
    })
    expect(t.description).toContain("All deferred tools are already activated")
  })

  test("name mode activates the tool and records activatedTool metadata", async () => {
    const t = buildToolSearchTool({ deferred, activated: new Set() })
    const result = await (t.execute as any)({ name: "pdf_parse" }, { toolCallId: "test" })
    expect(result.metadata.activatedTool).toBe("pdf_parse")
    expect(result.output).toContain("<tool_activated")
    expect(result.output).toContain("pdf_parse")
  })

  test("name mode returns suggestions instead of throwing for an unknown name", async () => {
    const t = buildToolSearchTool({ deferred, activated: new Set() })
    const result = await (t.execute as any)({ name: "nonexistent_tool" }, { toolCallId: "test" })
    expect(result.metadata.missing).toEqual(["nonexistent_tool"])
    expect(result.metadata.activatedTools).toBeUndefined()
    expect(result.output).toContain("<tool_search_results")
    expect(result.output).toContain("pdf_parse")
  })

  test("name mode treats an already loaded tool as a no-op", async () => {
    const t = buildToolSearchTool({ deferred, activated: new Set(), loaded: new Set(["bash"]) })
    const result = await (t.execute as any)({ name: "bash" }, { toolCallId: "test" })
    expect(result.output).toContain("<tool_already_available")
    expect(result.metadata.activatedTools).toEqual([])
  })

  test("name mode activates every tool in a comma-separated list", async () => {
    const t = buildToolSearchTool({ deferred, activated: new Set() })
    const result = await (t.execute as any)({ name: "pdf_parse, excel_parse" }, { toolCallId: "test" })
    expect(result.metadata.activatedTools).toEqual(["pdf_parse", "excel_parse"])
    // The single field stays for older versions.
    expect(result.metadata.activatedTool).toBe("pdf_parse")
  })

  test("name mode activates the known names and reports the rest as missing", async () => {
    const t = buildToolSearchTool({ deferred, activated: new Set() })
    const result = await (t.execute as any)({ name: "pdf_parse,nope" }, { toolCallId: "test" })
    expect(result.metadata.activatedTools).toEqual(["pdf_parse"])
    expect(result.metadata.missing).toEqual(["nope"])
  })

  test("query mode returns suggestions without activating anything", async () => {
    const t = buildToolSearchTool({ deferred, activated: new Set() })
    const result = await (t.execute as any)({ query: "excel" }, { toolCallId: "test" })
    expect(result.metadata.activatedTool).toBeUndefined()
    expect(result.output).toContain("<tool_search_results")
    expect(result.output).toContain("excel_parse")
    expect(result.output).not.toContain("pdf_parse")
  })
})

describe("buildDeferredPlan", () => {
  test("leaves a disabled built-in tool out of the list but keeps it pending", () => {
    const plan = buildDeferredPlan({
      standard: [{ id: "pdf_parse", description: "Parse PDF" }],
      mcp: {},
      deferredStandardIds: new Set(["pdf_parse"]),
      messages: [],
      disabled: (id) => id === "pdf_parse",
    })
    expect(plan.summaries).toEqual([])
    // Still deferred, so the runner keeps it out of the tools array.
    expect(plan.isPending("pdf_parse")).toBe(true)
    // An empty list means tool_search is not injected.
    expect(plan.hasPending).toBe(false)
  })

  test("leaves a disabled MCP tool out of the list as well", () => {
    const plan = buildDeferredPlan({
      standard: [],
      mcp: { srv_a: { __deferred: true }, srv_b: { __deferred: true } },
      deferredStandardIds: new Set(),
      messages: [],
      disabled: (id) => id === "srv_a",
    })
    expect(plan.summaries.map((t) => t.id)).toEqual(["srv_b"])
    expect(plan.isPending("srv_a")).toBe(true)
    expect(plan.isPending("srv_b")).toBe(true)
  })

  test("lists every deferred tool when disabled is not given", () => {
    const plan = buildDeferredPlan({
      standard: [{ id: "pdf_parse", description: "Parse PDF" }],
      mcp: { srv_x: { __deferred: true } },
      deferredStandardIds: new Set(["pdf_parse"]),
      messages: [],
    })
    expect(plan.summaries.map((t) => t.id).sort()).toEqual(["pdf_parse", "srv_x"])
    // Without a description the summary falls back to the id.
    expect(plan.summaries.find((t) => t.id === "srv_x")?.summary).toBe("srv_x")
  })

  test("summarizes an MCP description as its capped first line and searches the full text", () => {
    const plan = buildDeferredPlan({
      standard: [],
      mcp: {
        srv_y: { __deferred: true, description: "Short first line.\nraw payload beyond" },
        srv_z: { __deferred: true, description: "Do something verbose. ".repeat(40) },
      },
      deferredStandardIds: new Set(),
      messages: [],
    })
    const y = plan.summaries.find((t) => t.id === "srv_y")
    expect(y?.summary).toBe("Short first line.")
    expect(y?.searchText).toBe("Short first line.\nraw payload beyond")

    // A long first line is capped at MCP_SUMMARY_MAX with an ellipsis.
    const z = plan.summaries.find((t) => t.id === "srv_z")
    expect(z?.summary!.length).toBeLessThanOrEqual(120)
    expect(z?.summary!.endsWith("…")).toBe(true)
  })
})
