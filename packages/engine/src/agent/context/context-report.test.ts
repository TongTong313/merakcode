import { describe, expect, test } from "vitest"
import type { Agent } from "../agent"
import type { Provider } from "../model/provider"
import { RulesPrompt } from "../prompt/rules/prompt"
import { SessionContextReport } from "./context-report"
import type { SessionContextView } from "./context-view"

const count = { count: 0, tokens: 0 }

function fakeView(rules: RulesPrompt.Snapshot): SessionContextView.View {
  return {
    system: [],
    systemBreakdown: { environment: [], rules: [] },
    messages: [],
    sessionMessages: [],
    tokens: 0,
    rules,
    stats: {
      source: { messages: 0 },
      projected: { messages: 0, modelMessages: 0 },
      context: { instructions: 0, systemContext: 0, userContext: 0, extraSystem: 0, extraMessages: 0 },
      tokens: {
        agent: 0,
        instructions: 0,
        systemContext: 0,
        system: 0,
        userContext: 0,
        tools: 0,
        mcp: 0,
        messages: 0,
        toolResults: 0,
        estimated: 0,
        canonical: 0,
        preflight: 0,
        reserved: 0,
        free: 0,
        autoCompactThreshold: 0,
        autoCompactRemaining: 0,
        total: 0,
      },
      canonical: { source: "estimate", total: 0, baseline: 0, estimatedDelta: 0, estimatedFull: 0 },
      preflight: { total: 0, margin: 0 },
      tools: {
        standard: { count: 0, tokens: 0, names: [] },
        mcp: { count: 0, tokens: 0, names: [], status: {} },
        total: { count: 0, tokens: 0 },
      },
      toolResults: {
        budget: 0,
        recentTurns: 0,
        microcompact: { keep: 0, trigger: 0, active: false },
        original: count,
        kept: count,
        recent: count,
        protected: count,
        alreadyCleared: count,
        budgetCleared: count,
        microcompactCleared: count,
        input: { enabled: false, budget: 0, maxCharsPerField: 0, truncated: count },
      },
    },
  }
}

const agent = { id: "build" } as Agent.Info
const model = {
  id: "test",
  providerID: "test",
  limit: { context: 128_000, input: 0 },
} as Provider.Model

function format(rules: RulesPrompt.Snapshot) {
  return SessionContextReport.format({ view: fakeView(rules), agent, model })
}

describe("SessionContextReport rules section", () => {
  test("omits the Rules heading when there is nothing to show", () => {
    expect(format(RulesPrompt.emptySnapshot())).not.toContain("### Rules")
  })

  test("renders English labels when lang is en", () => {
    const text = SessionContextReport.format({
      view: fakeView({
        ...RulesPrompt.emptySnapshot(),
        always: [
          {
            name: "style",
            source: "native",
            type: "always",
            filepath: "/repo/.merakcode/rules/style.mdc",
            bytes: 12,
            tokens: 4,
            truncated: false,
            globs: [],
          },
        ],
      }),
      agent,
      model,
      lang: "en",
    })
    expect(text).toContain("## Context Report")
    expect(text).toContain("- Always applied: 1 /")
    expect(text).toContain("style (project, 12 bytes, 4 tokens)")
    expect(text).not.toMatch(/[一-鿿]/)
  })

  test("lists always, glob, pin, catalog, dropped, errors, and shadowed entries", () => {
    const text = format({
      always: [
        {
          name: "style",
          source: "native",
          type: "always",
          filepath: "/repo/.merakcode/rules/style.mdc",
          bytes: 12,
          tokens: 4,
          truncated: false,
          globs: [],
        },
      ],
      catalog: [
        {
          name: "rpc",
          source: "native",
          type: "agent-requested",
          filepath: "/repo/.merakcode/rules/rpc.mdc",
          bytes: 8,
          tokens: 2,
          truncated: false,
          globs: [],
        },
      ],
      glob: [
        {
          name: "ts",
          source: "native",
          type: "auto",
          filepath: "/repo/.merakcode/rules/ts.mdc",
          bytes: 20,
          tokens: 6,
          truncated: false,
          globs: ["**/*.ts"],
        },
      ],
      pinned: [
        {
          name: "review",
          source: "native",
          type: "manual",
          filepath: "/repo/.merakcode/rules/review.mdc",
          bytes: 16,
          tokens: 5,
          truncated: false,
          globs: [],
        },
      ],
      dropped: [
        {
          name: "old",
          source: "user-config",
          type: "always",
          filepath: "",
          bytes: 16000,
          tokens: 4000,
          truncated: true,
          globs: [],
        },
      ],
      droppedActive: [],
      errors: [{ filepath: "/repo/.merakcode/rules/broken.mdc", reason: "规则正文为空" }],
      shadowed: [{ directory: "/repo/.cursor/rules", by: 1 }],
      alwaysBytes: 12,
      alwaysBudget: RulesPrompt.MAX_SYSTEM_BYTES,
      activeBytes: 36,
      activeBudget: RulesPrompt.MAX_ACTIVE_RULE_BYTES,
      catalogTruncated: false,
    })

    expect(text).toContain("### Rules")
    expect(text).toContain("始终生效: 1 条")
    expect(text).toContain("style（项目")
    expect(text).toContain("智能规则目录: 1 条")
    expect(text).toContain("本轮 glob: 1 条")
    expect(text).toContain("本会话 pin: 1 条")
    expect(text).toContain("review（项目")
    expect(text).toContain("手动")
    expect(text).toContain("按需")
    expect(text).toContain("globs: **/*.ts")
    expect(text).toContain("始终生效预算丢弃: 1 条")
    expect(text).toContain("已截断")
    expect(text).toContain("加载失败: 1 条")
    expect(text).toContain("规则正文为空")
    expect(text).toContain(".cursor/rules 被遮蔽: 1 处")
  })
})
