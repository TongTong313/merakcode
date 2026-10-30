import z from "zod"

export namespace AgentConnectionConfig {
  export const ProductModel = z.object({
    id: z.string().trim().min(1),
    providerID: z.string().trim().min(1).optional(),
  })

  /** An external product shared by every project and conversation */
  export const AgentConnectionProduct = z.object({
    command: z.string().optional(),
    enabled: z.boolean().optional(),
    title: z.string().optional(),
    adapter: z.enum(["claude", "codex", "opencode", "command", "member"]).optional(),
    args: z.array(z.string()).optional(),
    resumeArgs: z.array(z.string()).optional(),
    sessionLine: z.string().optional(),
    model: ProductModel.optional(),
  })
  export type AgentConnectionProduct = z.infer<typeof AgentConnectionProduct>
}

export namespace ExternalSettings {
  const AgentConnectionProduct = AgentConnectionConfig.AgentConnectionProduct
  export const fields = {
    agentConnections: z
      .object({ products: z.record(z.string(), AgentConnectionProduct).optional() })
      .optional()
      .describe("Global external product connections shared by direct and group conversations"),
  }
}
