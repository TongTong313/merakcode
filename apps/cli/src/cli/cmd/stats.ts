import type { Argv } from "yargs"
import type { SessionStats } from "@merakcode/sdk/client"
import { cmd } from "./cmd"
import { withEngine } from "../engine"
import stringWidth from "string-width"
import { I18n } from "../i18n"

export const StatsCommand = cmd({
  command: "stats",
  describe: I18n.t("cli.stats.describe"),
  builder: (yargs: Argv) => {
    return yargs
      .option("days", {
        describe: I18n.t("cli.stats.days"),
        type: "number",
      })
      .option("tools", {
        describe: I18n.t("cli.stats.tools"),
        type: "number",
      })
      .option("models", {
        describe: I18n.t("cli.stats.models"),
      })
      .option("project", {
        describe: I18n.t("cli.stats.project"),
        type: "string",
      })
  },
  handler: async (args) => {
    // The engine aggregates (it reads all local sessions); --project without a value means the current project.
    const stats = await withEngine(async (sdk) => {
      const project =
        args.project === ""
          ? await sdk.project.current(undefined, { throwOnError: true }).then((x) => x.data.id)
          : args.project
      return sdk.global.stats({ days: args.days, project }, { throwOnError: true }).then((x) => x.data)
    })
    const modelLimit = args.models === true ? Infinity : typeof args.models === "number" ? args.models : undefined
    displayStats(stats, args.tools, modelLimit)
  },
})

function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56
  const t = (key: string) => I18n.t(key)

  // Pad by display width: full-width characters such as CJK take two columns, so padding by length misaligns.
  function renderRow(label: string, value: string): string {
    const padding = Math.max(0, width - 1 - stringWidth(label) - stringWidth(value))
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  function header(title: string) {
    const left = Math.floor((width - stringWidth(title)) / 2)
    console.log("┌" + "─".repeat(width) + "┐")
    console.log("│" + " ".repeat(left) + title + " ".repeat(Math.max(0, width - left - stringWidth(title))) + "│")
    console.log("├" + "─".repeat(width) + "┤")
  }

  // Overview section
  header(t("cli.stats.overview"))
  console.log(renderRow(t("cli.stats.sessions"), stats.totalSessions.toLocaleString()))
  console.log(renderRow(t("cli.stats.messages"), stats.totalMessages.toLocaleString()))
  console.log(renderRow(t("cli.stats.dayCount"), stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  header(t("cli.stats.costTokens"))
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  console.log(renderRow(t("cli.stats.totalCost"), `$${cost.toFixed(2)}`))
  console.log(renderRow(t("cli.stats.costPerDay"), `$${costPerDay.toFixed(2)}`))
  console.log(renderRow(t("cli.stats.tokensPerSession"), formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(renderRow(t("cli.stats.medianTokens"), formatNumber(Math.round(medianTokensPerSession))))
  console.log(renderRow(t("cli.stats.input"), formatNumber(stats.totalTokens.input)))
  console.log(renderRow(t("cli.stats.output"), formatNumber(stats.totalTokens.output)))
  console.log(renderRow(t("cli.stats.cacheRead"), formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow(t("cli.stats.cacheWrite"), formatNumber(stats.totalTokens.cache.write)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    header(t("cli.stats.modelUsage"))

    for (const [model, usage] of modelsToDisplay) {
      console.log(`│ ${model.padEnd(54)} │`)
      console.log(renderRow("  " + t("cli.stats.messages"), usage.messages.toLocaleString()))
      console.log(renderRow("  " + t("cli.stats.inputTokens"), formatNumber(usage.tokens.input)))
      console.log(renderRow("  " + t("cli.stats.outputTokens"), formatNumber(usage.tokens.output)))
      console.log(renderRow("  " + t("cli.stats.cacheRead"), formatNumber(usage.tokens.cache.read)))
      console.log(renderRow("  " + t("cli.stats.cacheWrite"), formatNumber(usage.tokens.cache.write)))
      console.log(renderRow("  " + t("cli.stats.cost"), `$${usage.cost.toFixed(4)}`))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    header(t("cli.stats.toolUsage"))

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
