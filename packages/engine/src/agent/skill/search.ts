import type { Agent } from "../agent"
import { PermissionNext } from "../permission/next"
import { Message } from "../session/message"
import {
  hasEnoughSecondaryMatches,
  normalize,
  termScore,
  termsForRank as textRankTermsForRank,
  tokenize,
} from "../../infra/match/text-rank"
import { Skill } from "./skill"

export namespace SkillSearch {
  export const DESCRIPTION_SAMPLE_LIMIT = 30
  export const SEARCH_DEFAULT_LIMIT = 20
  export const SEARCH_MAX_LIMIT = 50
  const ATTACHMENT_LIMIT = 5
  const CONTENT_SEARCH_LIMIT = 2_000
  const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "anything",
    "are",
    "as",
    "at",
    "be",
    "been",
    "being",
    "but",
    "by",
    "can",
    "create",
    "current",
    "do",
    "does",
    "file",
    "files",
    "for",
    "from",
    "help",
    "here",
    "how",
    "if",
    "in",
    "include",
    "into",
    "is",
    "it",
    "its",
    "just",
    "me",
    "need",
    "now",
    "of",
    "on",
    "only",
    "or",
    "please",
    "save",
    "skill",
    "skills",
    "task",
    "tasks",
    "that",
    "their",
    "them",
    "then",
    "there",
    "the",
    "this",
    "those",
    "to",
    "use",
    "using",
    "want",
    "when",
    "with",
    "you",
    "your",
  ])

  export type Attachment = {
    text: string
    skills: Skill.Info[]
    query: string
    messageID?: string
    triggerID?: string
  }

  /** metadata.skill.kind of the persisted marker part, used to dedupe suggestions across turns */
  export const METADATA_KIND = "skill_discovery"

  /**
   * Dedupe signature: query + ordered skill names. Whole skills are not compared because volatile fields such as
   * description and content would cause false mismatches.
   */
  function discoverySignature(query: string, skills: Skill.Info[]) {
    return JSON.stringify({ query, names: skills.map((skill) => skill.name) })
  }

  /** Builds the metadata of the persisted marker part, later matched by hasMatchingSuggestion */
  export function metadata(attachment: Pick<Attachment, "skills" | "query">) {
    return {
      skill: {
        kind: METADATA_KIND,
        signature: discoverySignature(attachment.query, attachment.skills),
      },
    }
  }

  /**
   * Whether the message history already contains the exact same skill suggestion (same query, same skills in the same
   * order). Dedupes across turns: a skill that becomes relevant again for a new query has a different signature and is
   * suggested again, so a skill is never suppressed for good.
   */
  export function hasMatchingSuggestion(messages: Message.FullMsg[], attachment: Pick<Attachment, "skills" | "query">) {
    const target = discoverySignature(attachment.query, attachment.skills)
    return messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" &&
          part.metadata?.skill?.kind === METADATA_KIND &&
          part.metadata.skill.signature === target,
      ),
    )
  }

  export function escapeXml(value: string) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
  }

  export function normalizeLimit(value: number | undefined) {
    if (value === undefined) return SEARCH_DEFAULT_LIMIT
    return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(value)))
  }

  export function renderSkillSummary(skill: Skill.Info) {
    return [
      `  <skill>`,
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `  </skill>`,
    ]
  }

  export function search(skills: Skill.Info[], query: string | undefined, limit: number) {
    const text = query?.trim() ?? ""
    if (!text) {
      return {
        matches: skills,
        shown: skills.slice(0, limit),
      }
    }

    const matches = rank({
      skills,
      query: text,
      limit: skills.length,
    })

    return {
      matches,
      shown: matches.slice(0, limit),
    }
  }

  export function filterAccessible(input: {
    skills: Skill.Info[]
    agent?: Agent.Info
    ruleset?: PermissionNext.Ruleset
  }) {
    if (!input.agent) return input.skills

    const ruleset =
      input.ruleset ?? PermissionNext.merge(input.agent.permission, input.agent.profile?.restrictedRules ?? [])

    return input.skills.filter((skill) => {
      if (skill.location.startsWith("<builtin>/")) return true
      return PermissionNext.evaluate("skill", skill.name, ruleset).action !== "deny"
    })
  }

  export async function accessible(
    input: {
      agent?: Agent.Info
      ruleset?: PermissionNext.Ruleset
      skills?: Skill.Info[]
    } = {},
  ) {
    const skills = input.skills ? input.skills : await Skill.all()
    return filterAccessible({
      skills,
      agent: input.agent,
      ruleset: input.ruleset,
    })
  }

  export function rank(input: { skills: Skill.Info[]; query: string; limit?: number; exclude?: Iterable<string> }) {
    const normalized = normalize(input.query)
    const terms = termsForRank(input.query)
    if (!normalized && terms.length === 0) return []

    const exclude = new Set(input.exclude ?? [])
    return input.skills
      .filter((skill) => !exclude.has(skill.name))
      .map((skill) => ({ skill, score: score(skill, normalized, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, input.limit ?? ATTACHMENT_LIMIT)
      .map((item) => item.skill)
  }

  export async function attachment(input: {
    messages: Message.FullMsg[]
    agent?: Agent.Info
    ruleset?: PermissionNext.Ruleset
    query?: string
    limit?: number
    exclude?: Iterable<string>
    messageID?: string
    triggerID?: string
  }): Promise<Attachment | undefined> {
    const query = (input.query ?? latestUserText(input.messages)).trim()
    if (!query) return undefined

    const exclude = new Set(input.exclude ?? [])
    for (const name of loadedSkillNames(input.messages)) {
      exclude.add(name)
    }

    const skills = rank({
      skills: await accessible({ agent: input.agent, ruleset: input.ruleset }),
      query,
      limit: input.limit,
      exclude,
    })
    if (skills.length === 0) return undefined

    return {
      text: renderAttachment(skills),
      skills,
      query,
      messageID: input.messageID,
      triggerID: input.triggerID,
    }
  }

  export function renderAttachment(skills: Skill.Info[]) {
    return [
      "<system-reminder>",
      "Skills relevant to your task:",
      "",
      ...skills.map((skill) => `- ${skill.name}: ${singleLine(skill.description)}`),
      "",
      "These skills encode reusable workflows and project-specific conventions.",
      "If one matches your next action, call the `skill` tool with the exact name to load complete instructions. " +
        "Skip this if none apply.",
      "</system-reminder>",
    ].join("\n")
  }

  export function latestUserText(messages: Message.FullMsg[]) {
    const message = messages.findLast((msg) => msg.info.role === "user")
    if (!message) return ""
    return Message.userTaskText(message)
  }

  export function loadedSkillNames(messages: Message.FullMsg[]) {
    const names = new Set<string>()
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "tool" || part.tool !== "skill" || part.state.status !== "completed") continue
        const inputName = typeof part.state.input.name === "string" ? part.state.input.name.trim() : ""
        const metadataName = typeof part.state.metadata.name === "string" ? part.state.metadata.name.trim() : ""
        const name = metadataName || inputName
        if (name) names.add(name)
      }
    }
    return names
  }

  function score(skill: Skill.Info, query: string, terms: string[]) {
    const name = normalize(skill.name)
    const description = normalize(skill.description)
    const content = normalize(skill.content.slice(0, CONTENT_SEARCH_LIMIT))
    const nameTerms = tokenize(skill.name)
    const descriptionTerms = tokenize(skill.description)
    const contentTerms = tokenize(skill.content.slice(0, CONTENT_SEARCH_LIMIT))
    let total = 0
    let direct = false

    if (query) {
      if (name === query) {
        total += 120
        direct = true
      } else if (name.startsWith(query)) {
        total += 72
        direct = true
      } else if (name.includes(query)) {
        total += 48
        direct = true
      }
      if (description.includes(query)) {
        total += 24
        direct = true
      }
      if (content.includes(query)) total += 4
    }

    let primaryMatches = 0
    let secondaryMatches = 0
    for (const term of terms) {
      const primary = termScore({
        term,
        tokens: nameTerms,
        haystack: name,
        exact: 24,
        prefix: 18,
        partial: 12,
      })
      const secondary = termScore({
        term,
        tokens: descriptionTerms,
        haystack: description,
        exact: 10,
        prefix: 7,
        partial: 5,
      })
      const tertiary = termScore({
        term,
        tokens: contentTerms,
        haystack: content,
        exact: 2,
        prefix: 1,
        partial: 1,
      })

      if (primary > 0) primaryMatches++
      if (secondary > 0) secondaryMatches++
      total += primary + secondary + tertiary
    }

    const matched = primaryMatches + secondaryMatches
    if (!direct && primaryMatches === 0 && !hasEnoughSecondaryMatches(terms, secondaryMatches)) {
      return 0
    }

    if (matched > 0 && terms.length > 0) total += (matched / terms.length) * 6
    if (skill.scope === "project") total += 3
    if (skill.scope === "builtin") total += 1
    return total
  }

  /** \u6784\u9020\u6280\u80fd\u641c\u7d22\u7528 term \u96c6\u5408\uff08\u590d\u7528 {@link TextRank} \u539f\u8bed\uff0c\u4f20\u5165\u6280\u80fd\u573a\u666f\u7684\u505c\u7528\u8bcd\u8868\uff09 */
  function termsForRank(query: string) {
    return textRankTermsForRank(query, STOP_WORDS)
  }

  function singleLine(value: string) {
    return value.replace(/\s+/g, " ").trim()
  }
}
