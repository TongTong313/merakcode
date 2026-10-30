import z from "zod"

export namespace SkillConfig {
  export const Skills = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z
      .array(z.string())
      .optional()
      .describe("URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)"),
  })
  export type Skills = z.infer<typeof Skills>
}

export namespace SkillSettings {
  const Skills = SkillConfig.Skills
  export const fields = {
    skills: Skills.optional().describe("Additional skill folder paths"),
  }
}
