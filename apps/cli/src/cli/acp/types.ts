import type { McpServer } from "@agentclientprotocol/sdk"
import type { MerakCodeClient } from "@merakcode/sdk/client"

export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: {
    providerID: string
    modelID: string
  }
  variant?: string
  modeId?: string
}

export interface ACPConfig {
  sdk: MerakCodeClient
  defaultModel?: {
    providerID: string
    modelID: string
  }
}
