/**
 * Real scenarios for automatic activation of deferred tools, checking both precision (nothing activated that is not
 * needed) and recall (what is needed gets activated). Changing triggerHint terms, scoring weights or the strong-match
 * rule trades one for the other, so watching only one side easily causes regressions.
 *
 * Expectations:
 * - empty expected → the result must be empty (precision)
 * - non-empty expected → the result must be non-empty and a subset of expected (recall; any reasonable tool counts)
 * - known gaps use test.fails: once a gap is fixed the test fails, as a reminder to make it a normal case
 */
import { describe, expect, test } from "vitest"
import { ToolDiscovery } from "./tool-discovery"
import { PdfParseTool } from "./pdf-parse"
import { ExcelParseTool } from "./excel-parse"
import { ExcelWriteTool } from "./excel-write"
import { WorkflowRunTool } from "../../app/task/tools/workflow"

/** Uses the real triggerHint values so the test cannot drift from them */
const builtin = [PdfParseTool, ExcelParseTool, ExcelWriteTool, WorkflowRunTool].map((tool) => ({
  id: tool.id,
  summary: "",
  triggerHint: tool.triggerHint,
}))

/** Simulated MCP tools with opaque ids and English-only descriptions, where Stage A reaches its limit */
const mcp = [
  { id: "notion_search_pages", summary: "", searchText: "Search pages across the Notion workspace by keyword" },
  { id: "notion_create_page", summary: "", searchText: "Create a new page in a Notion database" },
  { id: "sentry_list_issues", summary: "", searchText: "List unresolved issues for a Sentry project" },
  { id: "sentry_issue_detail", summary: "", searchText: "Fetch stacktrace and breadcrumbs for a Sentry issue" },
  { id: "postgres_run_query", summary: "", searchText: "Execute a read-only SQL query against the database" },
  { id: "figma_get_file", summary: "", searchText: "Read a Figma file node tree and design tokens" },
  { id: "k8s_get_pod_logs", summary: "", searchText: "Fetch logs from a Kubernetes pod" },
  { id: "jira_search_issues", summary: "", searchText: "Search Jira issues using JQL" },
]

type Case = {
  group: string
  name: string
  query: string
  expected: string[]
  pool?: "builtin" | "all"
  /** Known unresolved gap: still run, but marked so it is not mistaken for a new regression */
  gap?: string
}

const cases: Case[] = [
  // A: multi-agent orchestration
  {
    group: "A orchestration",
    name: "original production report (mixed Chinese and English)",
    query: "帮我用workflow来完成一个今日热点新闻的调研",
    expected: ["workflow_run"],
  },
  {
    group: "A orchestration",
    name: "all-Chinese wording",
    query: "用工作流把这几个模块的单测都补一遍",
    expected: ["workflow_run"],
  },
  {
    group: "A orchestration",
    name: "casual orchestration request",
    query: "帮我并行跑一批子任务，把 auth/billing/notify 三个模块都重构了",
    expected: ["workflow_run"],
    gap: "the word for parallel was dropped from the term list to cut false hits, so the model has to call tool_search",
  },
  {
    group: "A orchestration",
    name: "English technical wording",
    query: "fan out several agents to audit each package for dead code",
    expected: ["workflow_run"],
  },

  // B: documents and data
  {
    group: "B documents and data",
    name: "PDF paper",
    query: "把这篇论文里的实验数据整理出来",
    expected: ["pdf_parse"],
  },
  {
    group: "B documents and data",
    name: "spreadsheet asked for in Chinese",
    query: "帮我把压测结果整理成一个 xlsx 表格",
    expected: ["excel_write", "excel_parse"],
  },
  {
    group: "B documents and data",
    name: "several tools together",
    query: "读一下这份 PDF 说明书，把参数表导成 excel",
    expected: ["pdf_parse", "excel_parse", "excel_write"],
  },

  // C: plain coding tasks, where no deferred tool should activate
  {
    group: "C plain coding",
    name: "routine refactor",
    query: "把 UserService 里的重复校验逻辑抽成一个私有方法",
    expected: [],
  },
  { group: "C plain coding", name: "finding a bug", query: "登录接口偶发 500，帮我定位一下根因", expected: [] },
  { group: "C plain coding", name: "generic verb trap", query: "读取配置文件并生成一份默认配置", expected: [] },
  { group: "C plain coding", name: "adding tests", query: "给 parseRowRange 补几个边界用例", expected: [] },

  // D: adversarial, code entities that collide with tool domains (common when coding)
  {
    group: "D adversarial",
    name: "editing a tool's own source",
    query: "帮我改一下 excel-parse.ts 里 parseRowRange 的边界处理",
    expected: [],
  },
  {
    group: "D adversarial",
    name: "mentions a source file name",
    query: "pdf-parse.ts 的 classifyPage 有个分支覆盖不到，补个测试",
    expected: [],
  },
  {
    group: "D adversarial",
    name: "path-shaped text",
    query: "packages/engine/src/app/task/tools/workflow.ts 的 description() 拼串太长了，拆一下",
    expected: [],
  },
  {
    group: "D adversarial",
    name: "inline code in backticks",
    query: "`excel_write` 这个 id 在注册表里排序不稳，帮我看看",
    expected: [],
  },
  {
    group: "D adversarial",
    name: "CI process context",
    query: "我们的工作流程是先跑测试再部署，帮我把这段 CI 脚本改一下",
    expected: [],
    gap: "the Chinese word for work process is a triggerHint term; word matching cannot tell mentioning from wanting",
  },
  {
    group: "D adversarial",
    name: "talking about the tool itself",
    query: "解释一下 workflow_run 这个工具的延迟加载是怎么实现的",
    expected: [],
    gap: "same as above; it only costs one extra schema, dropped again after 12 turns",
  },

  // E: MCP tools with opaque ids, the limit of Stage A
  {
    group: "E MCP",
    name: "English words that match the id",
    query: "search notion pages about the release checklist",
    expected: ["notion_search_pages"],
    pool: "all",
  },
  {
    group: "E MCP",
    name: "knowledge base search in Chinese",
    query: "帮我在知识库里找一下上次发布的检查清单",
    expected: ["notion_search_pages"],
    pool: "all",
    gap: "a Chinese query shares no tokens with English ids, so deterministic scoring cannot work; this is why Stage B exists",
  },
  {
    group: "E MCP",
    name: "production errors asked for in Chinese",
    query: "看看线上最近有哪些未处理的报错",
    expected: ["sentry_list_issues"],
    pool: "all",
    gap: "same as above; needs tool_discovery.rerank=auto so a small model can help",
  },
  {
    group: "E MCP",
    name: "logs asked for in English",
    query: "get the pod logs for the failing checkout service",
    expected: ["k8s_get_pod_logs"],
    pool: "all",
  },
]

const groups = [...new Set(cases.map((item) => item.group))]

describe.each(groups)("%s", (group) => {
  for (const item of cases.filter((entry) => entry.group === group)) {
    const run = item.gap ? test.fails : test
    run(item.gap ? `${item.name} (known gap: ${item.gap})` : item.name, () => {
      const pool = item.pool === "all" ? [...builtin, ...mcp] : builtin
      const got = ToolDiscovery.autoActivateIds(ToolDiscovery.rank({ candidates: pool, query: item.query }))
      if (item.expected.length === 0) {
        expect(got).toEqual([])
        return
      }
      expect(got.length).toBeGreaterThan(0)
      expect(got.filter((id) => !item.expected.includes(id))).toEqual([])
    })
  }
})
