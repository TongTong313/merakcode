import type { AgentConnectionProduct } from "@merakcode/sdk/client"

export const connectionDefaults = {
  revision: 0,
  capabilities: {
    modelSelection: false,
    modelDiscovery: false,
    textStreaming: false,
    resume: false,
    permission: "external",
    questions: false,
  },
} satisfies Pick<AgentConnectionProduct, "revision" | "capabilities">
