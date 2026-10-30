import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import * as Builtin from "../skill/builtin"
import { Ripgrep } from "../../infra/file/ripgrep"
import { iife } from "@merakcode/util/iife"
import { SkillSearch } from "../skill/search"

/** Skill tool. permission.skill controls whether a skill may be loaded; only an explicit deny blocks it. */
export const SkillTool = Tool.define("skill", async (ctx) => {
  const allSkills = await Skill.all()

  // Same visible set as the skill discovery attachment (SkillSearch.filterAccessible: built-in agent allowlist and
  // permission checks). init has no runtime ruleset yet (session rules, permission mode), so visibility is filtered by
  // the agent's rules here; loading (ctx.ask with permission "skill" in execute) is judged on every call against the
  // runner's fresh ruleset, so session-level permission changes apply right away.
  const accessibleSkills = SkillSearch.filterAccessible({
    skills: allSkills,
    agent: ctx?.agent,
  })

  const sampleSkills = accessibleSkills.slice(0, SkillSearch.DESCRIPTION_SAMPLE_LIMIT)
  const remainingSkills = Math.max(0, accessibleSkills.length - sampleSkills.length)

  const description =
    accessibleSkills.length === 0
      ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          `There are ${accessibleSkills.length} skills available. The sample below is intentionally limited to keep the context small.`,
          "",
          "Use this tool in two modes:",
          "- Discovery: provide `query` to search available skills by name or description.",
          "- Loading: provide exact `name` to load the full skill instructions.",
          "",
          "If the task may need a skill that is not shown in the sample, search with a focused query first, then load the exact skill name returned by search.",
          "",
          'Loading output includes a `<skill_content name="...">` block with detailed instructions, workflows, and resource hints.',
          "",
          `<available_skill_sample shown="${sampleSkills.length}" total="${accessibleSkills.length}">`,
          ...sampleSkills.flatMap(SkillSearch.renderSkillSummary),
          "</available_skill_sample>",
          ...(remainingSkills > 0
            ? [
                "",
                `<more_skills count="${remainingSkills}">Call this tool with a query to discover additional skills.</more_skills>`,
              ]
            : []),
        ].join("\n")

  const examples = accessibleSkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().optional().describe(`Exact skill name to load after choosing a skill${hint}`),
    query: z.string().optional().describe("Search terms for discovering matching skills before loading one by name"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SkillSearch.SEARCH_MAX_LIMIT)
      .optional()
      .describe("Maximum number of search results to return"),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const name = params.name?.trim()

      if (!name) {
        const query = params.query?.trim()
        const limit = SkillSearch.normalizeLimit(params.limit)
        const { matches, shown } = SkillSearch.search(accessibleSkills, query, limit)

        return {
          title: query ? `Skill search: ${query}` : "Available skills",
          output: [
            `<skill_search query="${SkillSearch.escapeXml(query ?? "")}" shown="${shown.length}" matched="${matches.length}" total="${accessibleSkills.length}">`,
            ...shown.flatMap(SkillSearch.renderSkillSummary),
            "</skill_search>",
            ...(matches.length > shown.length
              ? [
                  "",
                  `<more_results count="${matches.length - shown.length}">Refine the query or increase limit up to ${SkillSearch.SEARCH_MAX_LIMIT} to see more matches.</more_results>`,
                ]
              : []),
            "",
            "Call this tool again with the exact `name` of the best matching skill to load its full instructions.",
          ].join("\n"),
          metadata: {
            query,
            total: accessibleSkills.length,
            matched: matches.length,
            shown: shown.length,
          } as Record<string, any>,
        }
      }

      const skill = accessibleSkills.find((item) => item.name === name)
      if (!skill) {
        const { shown } = SkillSearch.search(accessibleSkills, name, 10)
        const suggestions = shown.map((item) => item.name).join(", ")
        throw new Error(
          `Skill "${name}" not found. Search with query first to discover skills.${suggestions ? ` Possible matches: ${suggestions}` : ""}`,
        )
      }

      // The `<builtin>/` prefix alone is not trusted, since an external source could use it to skip the ask: the name
      // must also be registered in Builtin.getBuiltinSkill. Otherwise the skill is treated as external and asked about.
      const builtinSkillName = skill.location.startsWith("<builtin>/") ? skill.location.split("/")[1] : undefined
      const isBuiltinSkill = builtinSkillName ? Builtin.getBuiltinSkill(builtinSkillName) !== undefined : false
      if (!isBuiltinSkill) {
        await ctx.ask({
          permission: "skill",
          patterns: [name],
          metadata: {},
        })
      }

      if (isBuiltinSkill) {
        const skillName = builtinSkillName!
        const builtin = Builtin.getBuiltinSkill(skillName)
        const subfiles = builtin?.files ?? {}
        const fileNames = Object.keys(subfiles).filter((file) => file !== "SKILL.md")
        const base = `builtin-skill://${skillName}/`
        const hasFiles = fileNames.length > 0
        // With forward slashes: the shell on Windows is often bash, where a backslash escapes the next character
        const onDisk = builtin?.dir ? fileNames.map((file) => path.join(builtin.dir!, file).replaceAll("\\", "/")) : []
        const filesBlock = hasFiles
          ? [
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., req.md) are relative to this base directory.",
              "Use the `read` tool with the full builtin-skill:// URI to load any file below.",
              "",
              "<skill_files>",
              ...fileNames.map((file) => `<file>${base}${file}</file>`),
              "</skill_files>",
              ...(onDisk.length
                ? [
                    "",
                    "The same files on disk, to copy with shell commands (cp), which cannot read builtin-skill://:",
                    "<disk_files>",
                    ...onDisk.map((file) => `<file>${file}</file>`),
                    "</disk_files>",
                  ]
                : []),
            ]
          : ["This is a builtin skill with no associated files."]

        return {
          title: `Loaded skill: ${skill.name}`,
          output: [
            `<skill_content name="${skill.name}">`,
            `# Skill: ${skill.name}`,
            "",
            skill.content.trim(),
            "",
            ...filesBlock,
            "</skill_content>",
          ].join("\n"),
          metadata: {
            name: skill.name,
            dir: hasFiles ? base : "<builtin>",
          } as Record<string, any>,
        }
      }

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href
      const limit = 10
      const files = await iife(async () => {
        const arr = []
        for await (const file of Ripgrep.files({
          cwd: dir,
          follow: false,
          hidden: true,
          signal: ctx.abort,
        })) {
          if (file.includes("SKILL.md")) continue
          arr.push(path.resolve(dir, file))
          if (arr.length >= limit) break
        }
        return arr
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          skill.content.trim(),
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
        } as Record<string, any>,
      }
    },
  }
})
