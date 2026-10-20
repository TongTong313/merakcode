import { describe, expect, test } from "vitest"
import { buildStatusSections, describeMcpStatus, parsePluginSpec } from "../../src/cli/cmd/tui/component/status-view"

const mcpLabels = {
  connected: "已连接",
  failed: "连接失败",
  disabled: "已禁用",
}

describe("describeMcpStatus", () => {
  test("maps connected status to success tone", () => {
    expect(describeMcpStatus({ status: "connected" }, mcpLabels)).toEqual({
      tone: "success",
      detail: "已连接",
    })
  })

  test("maps failed status to error tone with server error", () => {
    expect(describeMcpStatus({ status: "failed", error: "timeout" }, mcpLabels)).toEqual({
      tone: "error",
      detail: "timeout",
    })
  })

  test("maps disabled status to muted tone", () => {
    expect(describeMcpStatus({ status: "disabled" }, mcpLabels)).toEqual({
      tone: "muted",
      detail: "已禁用",
    })
  })
})

describe("parsePluginSpec", () => {
  test("parses npm package with version", () => {
    expect(parsePluginSpec("@scope/pkg@1.2.3")).toEqual({
      name: "@scope/pkg",
      version: "1.2.3",
    })
  })

  test("parses plain package name without version", () => {
    expect(parsePluginSpec("my-plugin")).toEqual({
      name: "my-plugin",
      version: "latest",
    })
  })

  test("parses local file plugin from directory name", () => {
    expect(parsePluginSpec("file:///workspace/plugins/demo/index.ts")).toEqual({
      name: "demo",
    })
  })
})

describe("buildStatusSections", () => {
  const labels = {
    mcp: mcpLabels,
    mcpEmpty: "无 MCP 服务",
    lspEmpty: "无 LSP 服务",
    formatterEmpty: "无格式化器",
    pluginEmpty: "无插件",
  }

  test("sorts mcp rows by name and only includes enabled formatters", () => {
    const sections = buildStatusSections({
      mcp: {
        zebra: { status: "connected" },
        alpha: { status: "failed", error: "down" },
      },
      lsp: [{ id: "typescript", root: "/repo", status: "connected" }],
      formatters: [
        { name: "prettier", enabled: true },
        { name: "disabled-fmt", enabled: false },
      ],
      plugins: ["beta@2.0.0", "alpha@1.0.0"],
      labels,
    })

    expect(sections.mcp.rows.map((row) => row.title)).toEqual(["alpha", "zebra"])
    expect(sections.mcp.rows[0]?.tone).toBe("error")
    expect(sections.mcp.rows[1]?.tone).toBe("success")
    expect(sections.lsp?.rows.map((row) => row.title)).toEqual(["typescript"])
    expect(sections.formatters.rows.map((row) => row.title)).toEqual(["prettier"])
    expect(sections.plugins.rows.map((row) => row.title)).toEqual(["alpha", "beta"])
    expect(sections.plugins.rows[0]?.detail).toBe("@1.0.0")
  })

  test("returns empty section metadata when lists are empty", () => {
    const sections = buildStatusSections({
      mcp: {},
      lsp: [],
      formatters: [],
      plugins: [],
      labels,
    })

    expect(sections.mcp.empty).toBe(true)
    expect(sections.mcp.emptyLabel).toBe("无 MCP 服务")
    expect(sections.lsp).toBeUndefined()
    expect(sections.formatters.empty).toBe(true)
    expect(sections.plugins.empty).toBe(true)
  })
})
