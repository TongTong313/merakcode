import type { Agent } from "../agent/agent"
import type { Provider } from "../provider/provider"
import type { RulesPrompt } from "../rule/prompt"
import { ProviderTransform } from "../provider/transform"
import { Text } from "../util/text"
import type { SessionContextView } from "./context-view"

export namespace SessionContextReport {
  export type Input = {
    view: SessionContextView.View
    agent: Agent.Info
    model: Provider.Model
    /** The report (/context) is user-facing; callers pass await Text.lang(). Defaults to Chinese. */
    lang?: Text.Lang
  }

  export function format(input: Input) {
    const lang = input.lang ?? "zh"
    const t = (text: Text.Pair, params?: Record<string, unknown>) => Text.format(text, lang, params)
    const stats = input.view.stats
    const tools = stats.toolResults
    const limit = input.model.limit.input || input.model.limit.context
    const percent = limit > 0 ? ` (${Math.round((input.view.tokens / limit) * 100)}%)` : ""
    const canonical = stats.canonical
    const preflight = stats.preflight
    const microcompact = tools.microcompact.active
      ? t({ zh: "已启用", en: "active" })
      : t({ zh: "未触发", en: "not triggered" })
    const mcpStatus = Object.entries(stats.tools.mcp.status)
      .map(([name, status]) => `${name}:${status.status}`)
      .join(", ")

    return [
      t({ zh: "## 上下文报告", en: "## Context Report" }),
      "",
      `- Agent: ${input.agent.id}`,
      `- Model: ${input.model.providerID}/${input.model.id}`,
      `- Preflight tokens: ${formatTokens(input.view.tokens)}${percent}`,
      `- Canonical tokens: ${formatTokens(canonical.total)}`,
      t({ zh: "- 计算来源: {source}", en: "- Source: {source}" }, { source: canonical.source }),
      canonical.baselineMessageID ? `- Baseline message: ${canonical.baselineMessageID}` : undefined,
      `- Context limit: ${formatLimit(input.model.limit.context, lang)}`,
      `- Input limit: ${formatLimit(input.model.limit.input, lang)}`,
      t(
        { zh: "- 最大输出 tokens: {value}", en: "- Max output tokens: {value}" },
        { value: formatTokens(ProviderTransform.maxOutputTokens(input.model) ?? 0) },
      ),
      "",
      t({ zh: "### Token 分层", en: "### Token Breakdown" }),
      "",
      `- Agent prompt: ${formatTokens(stats.tokens.agent)}`,
      `- Instructions: ${formatTokens(stats.tokens.instructions)} (${formatSegments(stats.context.instructions, lang)})`,
      `- System context: ${formatTokens(stats.tokens.systemContext)} (${formatSegments(stats.context.systemContext, lang)})`,
      `- User/environment context: ${formatTokens(stats.tokens.userContext)} (${formatSegments(stats.context.userContext, lang)})`,
      `- Tools: ${formatTokens(stats.tokens.tools)} (${formatItems(stats.tools.standard.count, lang)})`,
      `- MCP: ${formatTokens(stats.tokens.mcp)} (${formatItems(stats.tools.mcp.count, lang)})`,
      `- Messages: ${formatTokens(stats.tokens.messages)}`,
      `- Tool results: ${formatTokens(stats.tokens.toolResults)}`,
      t(
        { zh: "- 本地全量估算: {value}", en: "- Local full estimate: {value}" },
        { value: formatTokens(stats.tokens.estimated) },
      ),
      t(
        { zh: "- Canonical 合计: {value}", en: "- Canonical total: {value}" },
        { value: formatTokens(stats.tokens.canonical) },
      ),
      t(
        { zh: "- Preflight 合计: {value}", en: "- Preflight total: {value}" },
        { value: formatTokens(stats.tokens.preflight) },
      ),
      "",
      t({ zh: "### Canonical 明细", en: "### Canonical Details" }),
      "",
      t(
        { zh: "- 真实 usage baseline: {value}", en: "- Actual usage baseline: {value}" },
        { value: formatTokens(canonical.baseline) },
      ),
      t(
        { zh: "- 新增消息估算: {value}", en: "- New messages estimate: {value}" },
        { value: formatTokens(canonical.estimatedDelta) },
      ),
      t(
        { zh: "- 本地全量估算参考: {value}", en: "- Local full estimate (reference): {value}" },
        { value: formatTokens(canonical.estimatedFull) },
      ),
      `- Preflight safety margin: ${formatTokens(preflight.margin)}`,
      "",
      t({ zh: "### 容量", en: "### Capacity" }),
      "",
      `- Reserved: ${formatTokens(stats.tokens.reserved)}`,
      `- Free: ${formatTokens(stats.tokens.free)}`,
      t(
        { zh: "- 距离自动压缩触发点: {value}", en: "- Until auto-compaction: {value}" },
        { value: formatRemaining(stats.tokens.autoCompactRemaining, lang) },
      ),
      "",
      "### Messages",
      "",
      t(
        { zh: "- 原始消息数: {value}", en: "- Source messages: {value}" },
        { value: formatCount(stats.source.messages) },
      ),
      t(
        { zh: "- 投影消息数: {value}", en: "- Projected messages: {value}" },
        { value: formatCount(stats.projected.messages) },
      ),
      t(
        { zh: "- 模型消息数: {value}", en: "- Model messages: {value}" },
        { value: formatCount(stats.projected.modelMessages) },
      ),
      "",
      "### Instructions",
      "",
      t(
        { zh: "- Instructions 段数: {value}", en: "- Instruction segments: {value}" },
        { value: formatCount(stats.context.instructions) },
      ),
      t(
        { zh: "- Extra system 段数: {value}", en: "- Extra system segments: {value}" },
        { value: formatCount(stats.context.extraSystem) },
      ),
      ...formatRules(input.view.rules, lang),
      "",
      "### Tools",
      "",
      t(
        { zh: "- 标准工具: {count} 个 / {tokens}", en: "- Standard tools: {count} / {tokens}" },
        { count: formatCount(stats.tools.standard.count), tokens: formatTokens(stats.tools.standard.tokens) },
      ),
      t(
        { zh: "- 标准工具列表: {list}", en: "- Standard tool list: {list}" },
        { list: formatList(stats.tools.standard.names, lang) },
      ),
      "",
      "### MCP",
      "",
      t(
        { zh: "- MCP 工具: {count} 个 / {tokens}", en: "- MCP tools: {count} / {tokens}" },
        { count: formatCount(stats.tools.mcp.count), tokens: formatTokens(stats.tools.mcp.tokens) },
      ),
      t({ zh: "- MCP 状态: {status}", en: "- MCP status: {status}" }, { status: mcpStatus || none(lang) }),
      t(
        { zh: "- MCP 工具列表: {list}", en: "- MCP tool list: {list}" },
        { list: formatList(stats.tools.mcp.names, lang) },
      ),
      "",
      "### Tool Results",
      "",
      t({ zh: "- 原始: {value}", en: "- Original: {value}" }, { value: formatBucket(tools.original) }),
      t({ zh: "- 本次发送保留: {value}", en: "- Kept in this request: {value}" }, { value: formatBucket(tools.kept) }),
      t(
        { zh: "- 最近轮次保护: {value}", en: "- Protected (recent turns): {value}" },
        { value: formatBucket(tools.recent) },
      ),
      t({ zh: "- 受保护工具: {value}", en: "- Protected tools: {value}" }, { value: formatBucket(tools.protected) }),
      t({ zh: "- 已清理: {value}", en: "- Already cleared: {value}" }, { value: formatBucket(tools.alreadyCleared) }),
      t(
        { zh: "- 预算清理: {value}", en: "- Cleared by budget: {value}" },
        { value: formatBucket(tools.budgetCleared) },
      ),
      t(
        { zh: "- Microcompact 清理: {value}", en: "- Cleared by microcompact: {value}" },
        { value: formatBucket(tools.microcompactCleared) },
      ),
      t(
        { zh: "- 老 tool-result 预算: {value}", en: "- Budget for old tool results: {value}" },
        { value: formatTokens(tools.budget) },
      ),
      t(
        {
          zh: "- Microcompact: {state}，超过 {trigger} 个后保留最近 {keep} 个",
          en: "- Microcompact: {state}; keeps the latest {keep} once there are more than {trigger}",
        },
        {
          state: microcompact,
          trigger: formatCount(tools.microcompact.trigger),
          keep: formatCount(tools.microcompact.keep),
        },
      ),
      t(
        {
          zh: "- 工具 input 截断: {state}，预算 {budget}，单字段上限 {max} 字符，本次截断 {count} 个 / {tokens}",
          en: "- Tool input truncation: {state}, budget {budget}, at most {max} characters per field, truncated in this request: {count} / {tokens}",
        },
        {
          state: tools.input.enabled ? t({ zh: "开启", en: "on" }) : t({ zh: "关闭", en: "off" }),
          budget: formatTokens(tools.input.budget),
          max: formatCount(tools.input.maxCharsPerField),
          count: formatCount(tools.input.truncated.count),
          tokens: formatTokens(tools.input.truncated.tokens),
        },
      ),
      "",
      t({
        zh: "预算和 microcompact 只影响本次发送给模型的投影上下文，不会删除已存储的会话历史。工具 input 截断仅截断历史 write/edit 入参内容字段（保留 filePath），模型需要全文时可用 Read 重读。",
        en: "The budget and microcompact only affect the projected context sent to the model in this request; stored session history is never deleted. Tool input truncation only shortens content fields of earlier write/edit inputs (filePath is kept), and the model can re-read the full text with Read when needed.",
      }),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n")
  }

  function formatRules(rules: RulesPrompt.Snapshot | undefined, lang: Text.Lang) {
    if (!rules) return []
    const empty =
      rules.always.length === 0 &&
      rules.catalog.length === 0 &&
      rules.glob.length === 0 &&
      rules.pinned.length === 0 &&
      rules.dropped.length === 0 &&
      rules.droppedActive.length === 0 &&
      rules.errors.length === 0 &&
      rules.shadowed.length === 0
    if (empty) return []

    const t = (text: Text.Pair, params?: Record<string, unknown>) => Text.format(text, lang, params)
    const line = (rule: RulesPrompt.Line) => formatRuleLine(rule, lang)
    const alwaysTokens = rules.always.reduce((sum, rule) => sum + rule.tokens, 0)
    const lines: Array<string | undefined> = [
      "",
      "### Rules",
      "",
      t(
        {
          zh: "- 始终生效: {count} 条 / {bytes} / {tokens}（预算 {budget}）",
          en: "- Always applied: {count} / {bytes} / {tokens} (budget {budget})",
        },
        {
          count: formatCount(rules.always.length),
          bytes: formatBytes(rules.alwaysBytes),
          tokens: formatTokens(alwaysTokens),
          budget: formatBytes(rules.alwaysBudget),
        },
      ),
      ...rules.always.map(line),
    ]
    if (rules.catalog.length > 0) {
      lines.push(
        t(
          { zh: "- 智能规则目录: {count} 条{suffix}", en: "- Smart rule catalog: {count}{suffix}" },
          {
            count: formatCount(rules.catalog.length),
            suffix: rules.catalogTruncated ? t({ zh: "（已截断）", en: " (truncated)" }) : "",
          },
        ),
      )
      lines.push(...rules.catalog.map(line))
    }
    if (rules.glob.length > 0) {
      lines.push(
        t(
          { zh: "- 本轮 glob: {count} 条", en: "- Glob rules this turn: {count}" },
          { count: formatCount(rules.glob.length) },
        ),
      )
      lines.push(...rules.glob.map(line))
    }
    if (rules.pinned.length > 0) {
      lines.push(
        t(
          { zh: "- 本会话 pin: {count} 条", en: "- Pinned in this session: {count}" },
          { count: formatCount(rules.pinned.length) },
        ),
      )
      lines.push(...rules.pinned.map(line))
    }
    if (rules.dropped.length > 0) {
      lines.push(
        t(
          { zh: "- 始终生效预算丢弃: {count} 条", en: "- Always-applied rules dropped by budget: {count}" },
          { count: formatCount(rules.dropped.length) },
        ),
      )
      lines.push(...rules.dropped.map(line))
    }
    if (rules.droppedActive.length > 0) {
      lines.push(
        t(
          {
            zh: "- 本轮规则预算丢弃: {count} 条（预算 {budget}）",
            en: "- Rules dropped by budget this turn: {count} (budget {budget})",
          },
          { count: formatCount(rules.droppedActive.length), budget: formatBytes(rules.activeBudget) },
        ),
      )
      lines.push(...rules.droppedActive.map(line))
    }
    if (rules.errors.length > 0) {
      lines.push(
        t(
          { zh: "- 加载失败: {count} 条", en: "- Failed to load: {count}" },
          { count: formatCount(rules.errors.length) },
        ),
      )
      lines.push(...rules.errors.map((item) => `  - ${item.filepath}: ${item.reason}`))
    }
    if (rules.shadowed.length > 0) {
      lines.push(
        t(
          { zh: "- .cursor/rules 被遮蔽: {count} 处", en: "- Shadowed .cursor/rules directories: {count}" },
          { count: formatCount(rules.shadowed.length) },
        ),
      )
      lines.push(
        ...rules.shadowed.map((item) =>
          t(
            {
              zh: "  - {directory}（被 {count} 条原生规则遮蔽）",
              en: "  - {directory} (shadowed by {count} native rules)",
            },
            { directory: item.directory, count: formatCount(item.by) },
          ),
        ),
      )
    }
    return lines
  }

  function formatRuleLine(rule: RulesPrompt.Line, lang: Text.Lang) {
    const t = (text: Text.Pair) => Text.format(text, lang)
    const bits = [sourceLabel(rule.source, lang), formatBytes(rule.bytes), formatTokens(rule.tokens)]
    if (rule.truncated) bits.push(t({ zh: "已截断", en: "truncated" }))
    if (rule.type === "manual") bits.push(t({ zh: "手动", en: "manual" }))
    if (rule.type === "agent-requested") bits.push(t({ zh: "按需", en: "on demand" }))
    if (rule.globs.length > 0) bits.push(`globs: ${rule.globs.join(", ")}`)
    return lang === "en" ? `  - ${rule.name} (${bits.join(", ")})` : `  - ${rule.name}（${bits.join("，")}）`
  }

  function sourceLabel(source: RulesPrompt.Line["source"], lang: Text.Lang) {
    if (source === "user-config") return Text.format({ zh: "全局配置", en: "global config" }, lang)
    if (source === "external") return ".cursor"
    return Text.format({ zh: "项目", en: "project" }, lang)
  }

  function none(lang: Text.Lang) {
    return Text.format({ zh: "无", en: "none" }, lang)
  }

  function formatSegments(value: number, lang: Text.Lang) {
    return Text.format({ zh: "{count} 段", en: "{count} segments" }, lang, { count: formatCount(value) })
  }

  function formatItems(value: number, lang: Text.Lang) {
    return Text.format({ zh: "{count} 个", en: "{count} items" }, lang, { count: formatCount(value) })
  }

  function formatBucket(bucket: { count: number; tokens: number }) {
    return `${formatCount(bucket.count)} / ${formatTokens(bucket.tokens)}`
  }

  function formatBytes(value: number) {
    return `${formatCount(value)} bytes`
  }

  function formatList(names: string[], lang: Text.Lang) {
    if (names.length === 0) return none(lang)
    const shown = names.slice(0, 30)
    const suffix = names.length > shown.length ? `, ... +${names.length - shown.length}` : ""
    return shown.join(", ") + suffix
  }

  function formatCount(value: number) {
    return value.toLocaleString("en-US")
  }

  function formatTokens(value: number) {
    return `${formatCount(value)} tokens`
  }

  function formatRemaining(value: number, lang: Text.Lang) {
    if (value >= 0)
      return Text.format({ zh: "{value} 后触发", en: "triggers in {value}" }, lang, { value: formatTokens(value) })
    return Text.format({ zh: "已超过触发点 {value}", en: "past the trigger by {value}" }, lang, {
      value: formatTokens(-value),
    })
  }

  function formatLimit(value: number | undefined, lang: Text.Lang) {
    if (!value || value <= 0) return Text.format({ zh: "无限制", en: "unlimited" }, lang)
    return formatTokens(value)
  }
}
