import { describe, expect, test } from "vitest"
import { ToolDiscovery } from "./tool-discovery"
import type { DeferredToolSummary } from "./tool-search"

/** Same tools as DEFAULT_DEFERRED_TOOLS, with their real triggerHint keywords. */
const candidates: DeferredToolSummary[] = [
  {
    id: "pdf_parse",
    summary: "Parse PDF files.",
    triggerHint: "pdf 论文 文献 扫描件 说明书 手册",
  },
  {
    id: "excel_parse",
    summary: "Read Excel workbooks.",
    triggerHint: "excel xlsx xlsm csv 表格 报表 电子表格 工作簿 数据表 sheet",
  },
  {
    id: "excel_write",
    summary: "Write Excel workbooks.",
    triggerHint: "excel xlsx xlsm 表格 报表 电子表格 工作簿 数据表 sheet 制表",
  },
  {
    id: "workflow_run",
    summary: "Execute a workflow script orchestrating child agents.",
    triggerHint: "workflow workflows 工作流 工作流程 流程编排 编排 扇出 fan-out fanout orchestrate 多智能体 子智能体",
  },
]

const idsOf = (query: string) => ToolDiscovery.autoActivateIds(ToolDiscovery.rank({ candidates, query }))

describe("queryTerms", () => {
  test("extracts an English word embedded in Chinese text without spaces", () => {
    // Without splitting at script boundaries the whole sentence is one token and never matches workflow_run.
    expect(ToolDiscovery.queryTerms("帮我用workflow来完成一个今日热点新闻的调研")).toContain("workflow")
  })

  test("produces CJK n-grams from a Chinese query for hint matching", () => {
    expect(ToolDiscovery.queryTerms("帮我做一个工作流")).toContain("工作流")
  })

  test("drops stop words", () => {
    expect(ToolDiscovery.queryTerms("please help me use the tool")).toEqual([])
  })

  test("clamps a long query so the number of terms stays bounded", () => {
    let long = ""
    for (let i = 0; i < 5000; i++) long += String.fromCharCode(0x4e00 + ((i * 7919) % 20000))
    // About three n-grams per character; unclamped this would be around 15000.
    expect(ToolDiscovery.queryTerms(long).length).toBeLessThan(ToolDiscovery.MAX_QUERY_CHARS * 4)
  })
})

describe("long queries keep the intent at either end", () => {
  const filler = "无关正文".repeat(500)

  test("intent before the pasted text", () => {
    expect(idsOf(`帮我用 workflow 分析下面这段日志：${filler}`)).toEqual(["workflow_run"])
  })

  test("intent after the pasted text", () => {
    expect(idsOf(`${filler}\n\n以上内容帮我用 workflow 调研一下`)).toEqual(["workflow_run"])
  })
})

describe("parseToolId", () => {
  test("splits snake_case on underscores", () => {
    expect(ToolDiscovery.parseToolId("workflow_run").parts).toEqual(["workflow", "run"])
  })

  test("splits camelCase used by custom and plugin tools", () => {
    expect(ToolDiscovery.parseToolId("CronCreate").parts).toEqual(["cron", "create"])
  })

  test("splits MCP ids (server_tool) on underscores", () => {
    expect(ToolDiscovery.parseToolId("codegraph_codegraph_explore").parts).toEqual([
      "codegraph",
      "codegraph",
      "explore",
    ])
  })
})

describe("rank / autoActivateIds", () => {
  test("activates workflow_run for a Chinese request that mentions workflow without spaces", () => {
    expect(idsOf("帮我用workflow来完成一个今日热点新闻的调研")).toEqual(["workflow_run"])
  })

  test("matches workflow_run through triggerHint for a Chinese-only query", () => {
    expect(idsOf("帮我用工作流完成这个任务")).toEqual(["workflow_run"])
  })

  test("matches id segments for an English query", () => {
    expect(idsOf("run a workflow for me")).toEqual(["workflow_run"])
  })

  test("a spreadsheet query matches both excel tools within AUTO_ACTIVATE_LIMIT", () => {
    const ids = idsOf("帮我整理成表格")
    expect(ids.length).toBeLessThanOrEqual(ToolDiscovery.AUTO_ACTIVATE_LIMIT)
    expect(ids.every((id) => id.startsWith("excel_"))).toBe(true)
  })

  test("pdf matches pdf_parse and not the excel tools", () => {
    expect(idsOf("解析这份 pdf")).toEqual(["pdf_parse"])
  })

  test("generic verbs such as parse, generate and read do not trigger activation", () => {
    expect(idsOf("帮我读取这个文件并生成一段说明")).toEqual([])
    expect(idsOf("解析一下这段代码")).toEqual([])
  })

  test("an unrelated query returns no candidates", () => {
    expect(ToolDiscovery.rank({ candidates, query: "修复登录页面的样式问题" })).toEqual([])
  })

  test("a blank query returns no candidates", () => {
    expect(ToolDiscovery.rank({ candidates, query: "   " })).toEqual([])
  })

  test("a description-only hit is ranked but not activated", () => {
    const weak: DeferredToolSummary[] = [
      { id: "some_tool", summary: "", searchText: "handles orchestration of background jobs" },
    ]
    const matches = ToolDiscovery.rank({ candidates: weak, query: "orchestration" })
    expect(matches.length).toBe(1)
    expect(matches[0]!.strong).toBe(false)
    expect(ToolDiscovery.autoActivateIds(matches)).toEqual([])
  })

  test("finds an MCP tool without triggerHint through its full description", () => {
    const mcp: DeferredToolSummary[] = [
      { id: "notion_search_pages", summary: "", searchText: "Search pages in the Notion workspace" },
    ]
    const matches = ToolDiscovery.rank({ candidates: mcp, query: "search notion pages" })
    expect(matches.map((m) => m.tool.id)).toEqual(["notion_search_pages"])
    // The id segment "notion" matches exactly, so the match is strong.
    expect(matches[0]!.strong).toBe(true)
  })
})

describe("serverNameOf", () => {
  test("matches the server name prefix", () => {
    expect(ToolDiscovery.serverNameOf("team-kb_kb_list", ["team-kb"])).toBe("team-kb")
  })

  test("prefers the longest server name when one is a prefix of another", () => {
    expect(ToolDiscovery.serverNameOf("abc-extra_tool", ["abc", "abc-extra"])).toBe("abc-extra")
  })

  test("sanitizes server names with spaces like MCP.tools() before matching", () => {
    expect(ToolDiscovery.serverNameOf("my_kb_kb_list", ["my kb"])).toBe("my kb")
  })

  test("returns undefined when no server matches", () => {
    expect(ToolDiscovery.serverNameOf("pdf_parse", ["team-kb"])).toBeUndefined()
  })
})

describe("expandMcpServerActivation", () => {
  const serverNames = ["team-kb", "codegraph"]
  const mcpIds = new Set([
    "team-kb_kb_list",
    "team-kb_kb_get_answer",
    "team-kb_kb_search",
    "team-kb_kb_add_qa",
    "codegraph_codegraph_node",
    "codegraph_codegraph_files",
  ])
  const candidates: DeferredToolSummary[] = [
    // team-kb, mostly query tools
    { id: "team-kb_kb_list", summary: "", searchText: "【查询用】列出知识库全部模块目录" },
    { id: "team-kb_kb_get_answer", summary: "", searchText: "【查询用·首选】用户提问、查用法优先调用" },
    { id: "team-kb_kb_search", summary: "", searchText: "【查询用】全文检索问答与手册" },
    { id: "team-kb_kb_add_qa", summary: "", searchText: "【写入·禁止用于查询】仅当用户明确要求记一条时调用" },
    // codegraph, an unrelated server that a team-kb hit must not expand
    { id: "codegraph_codegraph_node", summary: "", searchText: "One symbol's source" },
    { id: "codegraph_codegraph_files", summary: "", searchText: "Show project file structure" },
  ]

  test("a strong match activates every tool of its server and no other server", () => {
    const selected = ["team-kb_kb_add_qa"]
    const expanded = ToolDiscovery.expandMcpServerActivation({ selected, candidates, mcpIds, serverNames })
    expect([...expanded].sort()).toEqual([
      "team-kb_kb_add_qa",
      "team-kb_kb_get_answer",
      "team-kb_kb_list",
      "team-kb_kb_search",
    ])
    expect(expanded.every((id) => !id.startsWith("codegraph_"))).toBe(true)
  })

  test("keeps the selected tools first and appends the expansion", () => {
    const selected = ["team-kb_kb_add_qa"]
    const expanded = ToolDiscovery.expandMcpServerActivation({ selected, candidates, mcpIds, serverNames })
    expect(expanded[0]).toBe("team-kb_kb_add_qa")
    expect(expanded.slice(1).sort()).toEqual(["team-kb_kb_get_answer", "team-kb_kb_list", "team-kb_kb_search"])
  })

  test("returns built-in selections unchanged", () => {
    const selected = ["pdf_parse", "excel_parse"]
    expect(ToolDiscovery.expandMcpServerActivation({ selected, candidates, mcpIds, serverNames })).toEqual(selected)
  })

  test("keeps built-in selections and expands the MCP server of a mixed selection", () => {
    const selected = ["pdf_parse", "team-kb_kb_get_answer"]
    const expanded = ToolDiscovery.expandMcpServerActivation({ selected, candidates, mcpIds, serverNames })
    for (const id of ["pdf_parse", "team-kb_kb_list", "team-kb_kb_search"]) {
      expect(expanded).toContain(id)
    }
  })

  test("does not expand without server names", () => {
    const selected = ["team-kb_kb_add_qa"]
    expect(ToolDiscovery.expandMcpServerActivation({ selected, candidates, mcpIds, serverNames: [] })).toEqual(selected)
  })

  test("does not expand when no MCP tool is selected", () => {
    const selected = ["some_non_mcp_tool"]
    expect(ToolDiscovery.expandMcpServerActivation({ selected, candidates, mcpIds, serverNames })).toEqual(selected)
  })
})
