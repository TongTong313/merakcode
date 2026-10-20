/** Semantic tone of a status row; the UI maps it to a theme color. */
export type StatusTone = "success" | "error" | "muted" | "warning"

export type StatusRow = {
  title: string
  detail?: string
  subtitle?: string
  tone: StatusTone
}

export type StatusSection = {
  empty: boolean
  emptyLabel: string
  count: number
  rows: StatusRow[]
}

export type McpStatusLabels = {
  connected: string
  failed: string
  disabled: string
}

export type StatusViewLabels = {
  mcp: McpStatusLabels
  mcpEmpty: string
  lspEmpty: string
  formatterEmpty: string
  pluginEmpty: string
}

type McpEntry = { status: string; error?: string }
type LspEntry = { id: string; root: string; status: string }
type FormatterEntry = { name: string; enabled: boolean }
type PluginEntry = {
  id: string
  spec: string
  source: "internal" | "config"
  status: "active" | "degraded" | "failed"
  error?: string
  tools: string[]
}

/** Maps an MCP connection status to display text and tone. */
export function describeMcpStatus(status: McpEntry, labels: McpStatusLabels): { tone: StatusTone; detail: string } {
  if (status.status === "connected") return { tone: "success", detail: labels.connected }
  if (status.status === "disabled") return { tone: "muted", detail: labels.disabled }
  if (status.status === "failed") return { tone: "error", detail: status.error ?? labels.failed }
  return { tone: "muted", detail: status.status }
}

/** Parses a plugin specifier from config into a display name and version. */
export function parsePluginSpec(value: string): { name: string; version?: string } {
  if (value.startsWith("file://")) {
    const path = decodeURIComponent(new URL(value).pathname).replaceAll("\\", "/")
    const parts = path.split("/")
    const filename = parts.pop() || path
    if (!filename.includes(".")) return { name: filename }
    const basename = filename.split(".")[0]!
    if (basename === "index") {
      const dirname = parts.pop()
      return { name: dirname || basename }
    }
    return { name: basename }
  }
  const index = value.lastIndexOf("@")
  if (index <= 0) return { name: value, version: "latest" }
  return {
    name: value.substring(0, index),
    version: value.substring(index + 1),
  }
}

function lspTone(status: string): StatusTone {
  return status === "connected" ? "success" : "error"
}

/** Builds the read-only sections of the /status panel from the sync snapshot. */
export function buildStatusSections(input: {
  mcp: Record<string, McpEntry>
  lsp: LspEntry[]
  formatters: FormatterEntry[]
  plugins: Array<string | PluginEntry>
  labels: StatusViewLabels
}): {
  mcp: StatusSection
  lsp: StatusSection | undefined
  formatters: StatusSection
  plugins: StatusSection
} {
  const mcpRows = Object.entries(input.mcp)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, status]) => {
      const described = describeMcpStatus(status, input.labels.mcp)
      return {
        title: name,
        detail: described.detail,
        tone: described.tone,
      }
    })

  const lspRows = input.lsp.map((item) => ({
    title: item.id,
    subtitle: item.root,
    tone: lspTone(item.status),
  }))

  const formatterRows = input.formatters
    .filter((item) => item.enabled)
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((item) => ({
      title: item.name,
      tone: "success" as const,
    }))

  const pluginRows = input.plugins
    .map((item) => {
      if (typeof item === "string") {
        const parsed = parsePluginSpec(item)
        return {
          title: parsed.name,
          detail: parsed.version && parsed.version !== "latest" ? `@${parsed.version}` : undefined,
          tone: "success" as const,
        }
      }
      return {
        title: item.id,
        subtitle: item.source,
        detail: item.error ?? `${item.status} · ${item.tools.length} tools`,
        tone:
          item.status === "active"
            ? ("success" as const)
            : item.status === "failed"
              ? ("error" as const)
              : ("warning" as const),
      }
    })
    .toSorted((a, b) => a.title.localeCompare(b.title))

  return {
    mcp: {
      empty: mcpRows.length === 0,
      emptyLabel: input.labels.mcpEmpty,
      count: mcpRows.length,
      rows: mcpRows,
    },
    lsp:
      lspRows.length > 0
        ? {
            empty: false,
            emptyLabel: input.labels.lspEmpty,
            count: lspRows.length,
            rows: lspRows,
          }
        : undefined,
    formatters: {
      empty: formatterRows.length === 0,
      emptyLabel: input.labels.formatterEmpty,
      count: formatterRows.length,
      rows: formatterRows,
    },
    plugins: {
      empty: pluginRows.length === 0,
      emptyLabel: input.labels.pluginEmpty,
      count: pluginRows.length,
      rows: pluginRows,
    },
  }
}
