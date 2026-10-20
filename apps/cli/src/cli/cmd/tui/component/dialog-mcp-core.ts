export type ManagementMcpStatus = { status: "connected" } | { status: "disabled" } | { status: "failed"; error: string }

export interface ManagementMcpServer {
  name: string
  scope: "project" | "global"
  enabled: boolean
  status: ManagementMcpStatus
  tools: { count: number; tools: string[] }
}

export interface ManagementMcpSnapshot {
  servers: ManagementMcpServer[]
}

export const mcpDialogSource = "runtime" as const
export type McpDialogTab = "installed"
export const mcpDialogTabs: McpDialogTab[] = ["installed"]
export const mcpDialogHasHub = false
export const mcpDialogDefaultTab: McpDialogTab = "installed"

export function managementMcpRows(snapshot: ManagementMcpSnapshot | undefined) {
  return (snapshot?.servers ?? [])
    .map((server) => ({
      name: server.name,
      scope: server.scope,
      enabled: server.enabled,
      nextEnabled: !server.enabled,
      status: server.status,
      toolCount: server.tools.count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
