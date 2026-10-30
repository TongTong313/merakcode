import z from "zod"

export const ModelId = z.string()
export const RelayKind = z.enum(["claude-code", "codex", "standard", "custom"])

export namespace ProviderConfig {
  const ConfigModel = z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      family: z.string().optional(),
      release_date: z.string().optional(),
      attachment: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      temperature: z.boolean().optional(),
      tool_call: z.boolean().optional(),
      interleaved: z
        .union([z.literal(true), z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) }).strict()])
        .optional(),
      cost: z
        .object({
          input: z.number().optional(),
          output: z.number().optional(),
          cache_read: z.number().optional(),
          cache_write: z.number().optional(),
        })
        .optional(),
      limit: z
        .object({
          context: z.number().optional(),
          input: z.number().optional(),
          output: z.number().optional(),
        })
        .optional(),
      modalities: z
        .object({
          input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
          output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
        })
        .optional(),
      status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
      options: z.record(z.string(), z.any()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
      variants: z
        .record(
          z.string(),
          z
            .object({
              disabled: z.boolean().optional().describe("Disable this variant for the model"),
            })
            .catchall(z.any()),
        )
        .optional()
        .describe("Variant-specific configuration"),
    })
    .partial()

  export const Provider = z
    .object({
      api: z.string().optional(),
      name: z.string().optional(),
      env: z.array(z.string()).optional(),
      id: z.string().optional(),
      npm: z.string().optional(),
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      picker: z
        .object({
          include: z.array(z.string()).optional(),
          exclude: z.array(z.string()).optional(),
        })
        .optional()
        .describe("Homepage visibility delta. include turns a model on, exclude turns a default model off."),
      relay: z
        .object({
          station: z.string().min(1),
          group: z.string().min(1),
          kind: RelayKind,
          auth: z.enum(["bearer", "x-api-key"]).optional(),
        })
        .optional(),
      models: z.record(z.string(), ConfigModel).optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          promptCacheRetention: z
            .enum(["in_memory", "24h"])
            .optional()
            .describe("OpenAI prompt cache retention policy when promptCacheKey is enabled."),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>
}

export namespace ModelSettings {
  const Provider = ProviderConfig.Provider
  export const fields = {
    disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
    enabled_providers: z
      .array(z.string())
      .optional()
      .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
    model: ModelId.describe("Model to use in the format of provider/model, eg anthropic/claude-2").optional(),
    small_model: ModelId.describe(
      "Small model to use for tasks like title generation in the format of provider/model",
    ).optional(),
    provider: z.record(z.string(), Provider).optional().describe("Custom provider configurations and model overrides"),
    enterprise: z
      .object({
        url: z.string().optional().describe("Enterprise URL"),
      })
      .optional(),
  }

  /** Whether a model id points to the provider being deleted, or to the given model of it */
  export function modelRefStale(value: string, providerID: string, modelID?: string): boolean {
    if (modelID !== undefined) return value === `${providerID}/${modelID}`
    return value.startsWith(`${providerID}/`)
  }

  /** Removes, in memory, the model references that point to the provider/model being deleted */
  export function clearStaleModelRefs(cfg: Record<string, unknown>, providerID: string, modelID?: string) {
    const hit = (v: unknown) => typeof v === "string" && modelRefStale(v, providerID, modelID)

    for (const key of ["model", "small_model"]) {
      if (hit(cfg[key])) delete cfg[key]
    }

    const agent = cfg["agent"]
    if (agent && typeof agent === "object" && !Array.isArray(agent)) {
      for (const [, entry] of Object.entries(agent)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
        const rec = entry as Record<string, unknown>
        if (hit(rec["model"])) delete rec["model"]
      }
    }
  }
}
