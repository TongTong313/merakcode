import z from "zod"

export namespace RuleConfig {
  export const Rules = z.object({
    user: z
      .array(z.string())
      .optional()
      .describe(
        "Global user rules, always applied across all projects. Only read from global config; ignored in project config.",
      ),
  })
  export type Rules = z.infer<typeof Rules>
}

export namespace RuleSettings {
  export function merge(target: { instructions?: string[] }, source: { instructions?: string[] }) {
    if (!target.instructions || !source.instructions) return {}
    return { instructions: Array.from(new Set([...target.instructions, ...source.instructions])) }
  }
  const Rules = RuleConfig.Rules
  export const fields = {
    instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
    rules: Rules.optional(),
  }
}
