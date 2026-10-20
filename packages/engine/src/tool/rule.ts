import z from "zod"
import { Tool } from "./tool"
import { Rule } from "../rule/rule"
import { RuleMatch } from "../rule/match"
import { RuleSession } from "../rule/session-state"
import { Flag } from "../flag/flag"
import { Text } from "../util/text"

type RuleMetadata = {
  filepath?: string
}

export const RuleTool = Tool.define("rule", async () => {
  const requested = Flag.MERAKCODE_DISABLE_RULES ? [] : await Rule.byType("agent-requested")
  const names = requested.map((rule) => rule.name).filter(Boolean)
  const sample = names.slice(0, 8).join(", ")
  const hint = sample
    ? ` Available: ${sample}${names.length > 8 ? ", …" : ""}.`
    : " No Apply Intelligently rules are loaded."

  const description = [
    "Fetch an Apply Intelligently project rule by name or filepath and keep it active for the rest of this session.",
    "Only rules with a description and no globs (agent-requested) can be fetched.",
    "The rule body is injected automatically on later turns; this tool returns a short confirmation, not the full text.",
    hint,
  ].join(" ")

  const parameters = z.object({
    name: z.string().optional().describe("Exact rule name from the optional-rules catalog"),
    filepath: z.string().optional().describe("Absolute path of the .mdc rule file"),
  })

  return {
    description,
    parameters,
    async execute(
      params: z.infer<typeof parameters>,
      ctx,
    ): Promise<{ title: string; output: string; metadata: RuleMetadata }> {
      const title = await Text.pick({ zh: "规则", en: "Rule" })
      if (Flag.MERAKCODE_DISABLE_RULES) {
        return { title, output: "Rules are disabled.", metadata: {} }
      }
      const name = params.name?.trim()
      const filepath = params.filepath?.trim()
      if (!name && !filepath) {
        return { title, output: "Provide the name or file path of an Apply Intelligently rule.", metadata: {} }
      }

      const all = await Rule.all()
      const rule = filepath ? RuleMatch.byFilepath(all, filepath) : all.find((item) => item.name === name)

      if (!rule) {
        return { title, output: `Rule not found: ${filepath || name}`, metadata: {} }
      }
      if (rule.type !== "agent-requested") {
        return {
          title: rule.name,
          output: `Rule "${rule.name}" is not an Apply Intelligently rule and cannot be loaded with this tool.`,
          metadata: {},
        }
      }
      if (!RuleMatch.allowsAgent(rule, ctx.agent)) {
        return {
          title: rule.name,
          output: `Rule "${rule.name}" is not available to agent "${ctx.agent}".`,
          metadata: {},
        }
      }

      await RuleSession.pin(ctx.sessionID, rule.filepath, "fetch")
      return {
        title: rule.name,
        output: `Rule "${rule.name}" is now active for this session; its body will be injected into this and later turns.`,
        metadata: { filepath: rule.filepath },
      }
    },
  }
})
