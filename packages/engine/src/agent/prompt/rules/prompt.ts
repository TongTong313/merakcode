import { Token } from "../../context/token"
import { Log } from "@merakcode/log/logger"
import { InstructionPrompt } from "../../context/instruction"
import type { Message } from "../../session/message"
import { Rule } from "./rule"
import { RuleMatch } from "./match"
import { RuleSession } from "./session-state"
import { RuleWorkingSet } from "./working-set"

const log = Log.create({ service: "rule.prompt" })

/**
 * Always-on rules go into the system prompt; glob and pinned rule bodies go into the user context; the catalog of
 * agent-requested rules goes into the system prompt.
 */
export namespace RulesPrompt {
  export const MAX_SYSTEM_BYTES = 32 * 1024
  export const MAX_ACTIVE_RULE_BYTES = 32 * 1024
  export const MAX_CATALOG_BYTES = 4 * 1024

  /** AGENTS.md's place in the layer order: more general rules come before it, more specific ones after */
  const AGENTS_MD_LAYER = 30

  export type Built = {
    before: string[]
    after: string[]
    kept: Rule.Info[]
    dropped: Rule.Info[]
    bytes: number
  }

  export type Catalog = {
    text: string
    rules: Rule.Info[]
    truncated: boolean
    bytes: number
  }

  export type Active = {
    blocks: string[]
    glob: Rule.Info[]
    pinned: Rule.Info[]
    dropped: Rule.Info[]
    bytes: number
  }

  export type Line = {
    name: string
    source: Rule.Source
    type: Rule.Type
    filepath: string
    bytes: number
    tokens: number
    truncated: boolean
    globs: string[]
  }

  export type Snapshot = {
    always: Line[]
    catalog: Line[]
    glob: Line[]
    pinned: Line[]
    dropped: Line[]
    droppedActive: Line[]
    errors: Rule.LoadError[]
    shadowed: Rule.Shadowed[]
    alwaysBytes: number
    alwaysBudget: number
    activeBytes: number
    activeBudget: number
    catalogTruncated: boolean
  }

  export function emptySnapshot(): Snapshot {
    return {
      always: [],
      catalog: [],
      glob: [],
      pinned: [],
      dropped: [],
      droppedActive: [],
      errors: [],
      shadowed: [],
      alwaysBytes: 0,
      alwaysBudget: MAX_SYSTEM_BYTES,
      activeBytes: 0,
      activeBudget: MAX_ACTIVE_RULE_BYTES,
      catalogTruncated: false,
    }
  }

  export function line(rule: Rule.Info): Line {
    return {
      name: rule.name,
      source: rule.source,
      type: rule.type,
      filepath: rule.filepath,
      bytes: rule.bytes,
      tokens: Token.estimate(block(rule)),
      truncated: rule.truncated,
      globs: rule.globs,
    }
  }

  export function block(rule: Rule.Info) {
    const origin = rule.filepath ? `Rule from: ${rule.filepath}` : `Rule: ${rule.name} (global user rule)`
    return `${origin}\n${rule.content}`
  }

  export async function build(options?: { agent?: string }): Promise<Built> {
    const rules = (await Rule.byType("always")).filter((rule) => RuleMatch.allowsAgent(rule, options?.agent))
    if (rules.length === 0) return { before: [], after: [], kept: [], dropped: [], bytes: 0 }

    const ordered = rules.slice().sort(RuleMatch.order)

    const kept = new Set<Rule.Info>()
    const dropped: Rule.Info[] = []
    let bytes = 0
    for (let i = ordered.length - 1; i >= 0; i--) {
      const rule = ordered[i]
      const size = Buffer.byteLength(block(rule), "utf8")
      if (bytes + size > MAX_SYSTEM_BYTES) {
        dropped.push(rule)
        continue
      }
      bytes += size
      kept.add(rule)
    }

    const before: string[] = []
    const after: string[] = []
    for (const rule of ordered) {
      if (!kept.has(rule)) continue
      ;(rule.layer < AGENTS_MD_LAYER ? before : after).push(block(rule))
    }

    dropped.reverse()
    if (dropped.length > 0) {
      log.warn("always-apply rules exceeded the system byte budget", {
        dropped: dropped.map((rule) => rule.filepath || rule.id),
        bytes,
        budget: MAX_SYSTEM_BYTES,
      })
    }
    const keptRules = ordered.filter((rule) => kept.has(rule))
    return { before, after, kept: keptRules, dropped, bytes }
  }

  export async function catalog(options?: { agent?: string }): Promise<Catalog> {
    const rules = (await Rule.byType("agent-requested"))
      .filter((rule) => RuleMatch.allowsAgent(rule, options?.agent))
      .sort(RuleMatch.order)
    if (rules.length === 0) return { text: "", rules: [], truncated: false, bytes: 0 }

    const header = [
      "Optional rules (Apply Intelligently). Read the description and fetch a rule with the rule tool if it is relevant to the current task.",
      "Once fetched, it stays for the rest of this session.",
      "",
    ].join("\n")

    const kept: Rule.Info[] = []
    const lines: string[] = [header]
    let bytes = Buffer.byteLength(header, "utf8")
    let truncated = false
    for (const rule of rules) {
      const row = `- ${rule.name}: ${rule.description}${rule.filepath ? `  (${rule.filepath})` : ""}`
      const size = Buffer.byteLength(row + "\n", "utf8")
      if (bytes + size > MAX_CATALOG_BYTES) {
        truncated = true
        continue
      }
      bytes += size
      kept.push(rule)
      lines.push(row)
    }
    return { text: lines.join("\n"), rules: kept, truncated, bytes }
  }

  export async function active(input: {
    sessionID: string
    agent?: string
    messages: Message.FullMsg[]
  }): Promise<Active> {
    const empty: Active = { blocks: [], glob: [], pinned: [], dropped: [], bytes: 0 }
    const [all, data, workingSet] = await Promise.all([
      Rule.all(),
      RuleSession.snapshot(input.sessionID),
      RuleWorkingSet.collect({ sessionID: input.sessionID, messages: input.messages }),
    ])

    const seen = new Set<string>()
    const glob: Rule.Info[] = []
    const pinned: Rule.Info[] = []

    const take = (rule: Rule.Info, into: Rule.Info[]) => {
      if (seen.has(rule.id)) return
      seen.add(rule.id)
      into.push(rule)
    }

    const working = new Set(workingSet)
    for (const target of working) {
      for (const rule of RuleMatch.forFile(all, target, { agent: input.agent })) {
        if (rule.filepath && working.has(rule.filepath)) continue
        take(rule, glob)
      }
    }

    const stalePins: string[] = []
    for (const item of data.pinned) {
      const rule = RuleMatch.byFilepath(all, item.filepath)
      if (!rule || (rule.type !== "manual" && rule.type !== "agent-requested")) {
        stalePins.push(item.filepath)
        continue
      }
      take(rule, pinned)
    }
    if (stalePins.length > 0) await RuleSession.prunePins(input.sessionID, stalePins)

    glob.sort(RuleMatch.order)
    pinned.sort(RuleMatch.order)

    // Budget: pinned rules (session conventions) first, then glob rules from specific to general. Over budget, drop
    // the most general glob rules first, then the oldest pins
    const kept = new Set<Rule.Info>()
    const dropped: Rule.Info[] = []
    let bytes = 0

    const pinReversed = pinned.slice().reverse()
    const globReversed = glob.slice().reverse()
    for (const rule of [...pinReversed, ...globReversed]) {
      const size = Buffer.byteLength(block(rule), "utf8")
      if (bytes + size > MAX_ACTIVE_RULE_BYTES) {
        dropped.push(rule)
        continue
      }
      bytes += size
      kept.add(rule)
    }

    const keptGlob = glob.filter((rule) => kept.has(rule))
    const keptPinned = pinned.filter((rule) => kept.has(rule))
    const bodyBlocks: string[] = []
    for (const rule of [...keptGlob, ...keptPinned].sort(RuleMatch.order)) {
      bodyBlocks.push(block(rule))
    }

    if (dropped.length > 0) {
      log.warn("active rules exceeded the user-context byte budget", {
        dropped: dropped.map((rule) => rule.filepath || rule.id),
        bytes,
        budget: MAX_ACTIVE_RULE_BYTES,
      })
    }

    if (bodyBlocks.length === 0) return { ...empty, dropped }

    return {
      blocks: [[InstructionPrompt.PRECEDENCE_NOTE, "", ...bodyBlocks].join("\n")],
      glob: keptGlob,
      pinned: keptPinned,
      dropped,
      bytes,
    }
  }

  export async function snapshot(input: {
    agent?: string
    sessionID: string
    built?: Built
    catalog?: Catalog
    active?: Active
  }): Promise<Snapshot> {
    const built = input.built ?? (await build({ agent: input.agent }))
    const catalogBuilt = input.catalog ?? (await catalog({ agent: input.agent }))
    const activeBuilt =
      input.active ??
      (await active({
        sessionID: input.sessionID,
        agent: input.agent,
        messages: [],
      }))
    const [errors, shadowed] = await Promise.all([Rule.errors(), Rule.shadowed()])
    return {
      always: built.kept.map(line),
      catalog: catalogBuilt.rules.map(line),
      glob: activeBuilt.glob.map(line),
      pinned: activeBuilt.pinned.map(line),
      dropped: built.dropped.map(line),
      droppedActive: activeBuilt.dropped.map(line),
      errors,
      shadowed,
      alwaysBytes: built.bytes,
      alwaysBudget: MAX_SYSTEM_BYTES,
      activeBytes: activeBuilt.bytes,
      activeBudget: MAX_ACTIVE_RULE_BYTES,
      catalogTruncated: catalogBuilt.truncated,
    }
  }
}
