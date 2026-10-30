import { tool, jsonSchema, type Tool as AITool } from "ai"
import type { Message } from "../session/message"
import { ToolDiscovery } from "./tool-discovery"
import { Log } from "@merakcode/log/logger"

const log = Log.create({ service: "tool.discovery" })

/**
 * The tool_search meta tool, cross-turn activation scanning and the deferred loading plan.
 *
 * Tools load on demand, like skills:
 * - Rarely used built-in tools and deferred MCP tools stay out of the tools array; tool_search lists their names and
 *   summaries in its description.
 * - The model calls tool_search(name) to activate one, and the next turn the runner adds its full schema.
 * - Activation is recovered by scanning message history, so it needs no storage and replays. Compaction carries it in
 *   CompactionPart.preCompactActivatedTools, so it survives compaction.
 *
 * runner.resolveTools builds and injects this tool, like StructuredOutput; it is not in ToolRegistry.all() or
 * STANDARD_TOOL_POOL, so it stays out of the regular tool init and pool filtering.
 */

/**
 * Lightweight description of a deferred tool.
 *
 * Display and search fields are separate: showing extra description to the model brings no benefit, but the same
 * text helps as a scoring signal. summary is what the model sees; triggerHint and searchText only feed the scorer.
 */
export type DeferredToolSummary = {
  id: string
  /** Shown to the model: the first line of the tool description. */
  summary: string
  /** Search only: hand-written cross-language aliases, see Tool.Info.triggerHint. Never sent in a prompt. */
  triggerHint?: string
  /** Search only: the full description, mainly a fallback for MCP tools, which have no triggerHint. */
  searchText?: string
}

/**
 * Escapes XML special characters, including `"`: ids and queries go into name="..." attributes, and a query is free
 * model input whose quotes would break the attribute.
 */
function escapeXml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

/**
 * User turns an activated tool may stay unused before it becomes deferred again.
 *
 * If activations only accumulated, long sessions would carry more and more full schemas and deferred loading would
 * stop paying off. The count restarts whenever the tool is activated or called, so tools in use are never reclaimed;
 * a reclaimed tool costs one extra tool_search round trip.
 */
export const ACTIVATION_IDLE_TURNS = 12

/**
 * Metadata field and kind of the part that records an automatic activation.
 *
 * Mirrors the skill discovery record (SkillSearch.METADATA_KIND, metadata.skill): a synthetic text part with
 * ignored=true that never reaches the model and only serves as a replay anchor for {@link scanActivatedTools}. Auto
 * activation therefore needs no storage and still replays; compaction carries it in preCompactActivatedTools.
 */
export const AUTO_ACTIVATION_METADATA_FIELD = "toolDiscovery"
export const AUTO_ACTIVATION_METADATA_KIND = "tool_auto_activation"

/** Metadata for the part that records an automatic activation. */
export function autoActivationMetadata(ids: string[]) {
  return { [AUTO_ACTIVATION_METADATA_FIELD]: { kind: AUTO_ACTIVATION_METADATA_KIND, ids } }
}

/**
 * Scans message history for the deferred tools that are still activated this turn.
 *
 * Any of these counts as use in a turn:
 * - A tool_search result: metadata.activatedTools, else the older single metadata.activatedTool, else the call's
 *   input.name split on commas. metadata wins because execute only records validated names.
 * - An automatic activation record: the synthetic text part the runner writes on a Stage A strong match (see
 *   {@link AUTO_ACTIVATION_METADATA_KIND}); ignored=true, so it never reaches the model.
 * - A compaction boundary: CompactionPart carries the activations from before compaction, because filterCompacted
 *   drops the earlier tool_search calls and records.
 * - A call to the tool itself, which restarts its idle count (see ACTIVATION_IDLE_TURNS).
 *
 * Tools unused for more than ACTIVATION_IDLE_TURNS turns are dropped.
 */
export function scanActivatedTools(messages: Message.FullMsg[]): Set<string> {
  // tool name -> user turn of its last activation or call
  const lastSeen = new Map<string, number>()
  const everActivated = new Set<string>()
  let turn = 0

  const remember = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    everActivated.add(trimmed)
    lastSeen.set(trimmed, turn)
  }
  /** metadata values are untyped, so every item is checked. */
  const stringsOf = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

  for (const message of messages) {
    if (message.info.role === "user") turn++
    for (const part of message.parts) {
      if (part.type === "compaction") {
        for (const name of part.preCompactActivatedTools ?? []) remember(name)
        continue
      }
      if (part.type === "text") {
        const discovery = part.metadata?.[AUTO_ACTIVATION_METADATA_FIELD] as
          { kind?: string; ids?: unknown } | undefined
        if (discovery?.kind === AUTO_ACTIVATION_METADATA_KIND) {
          for (const id of stringsOf(discovery.ids)) remember(id)
        }
        continue
      }
      if (part.type !== "tool") continue
      if (part.tool === "tool_search") {
        if (part.state.status !== "completed") continue
        const metadata = part.state.metadata as Record<string, unknown> | undefined
        // activatedTools is the validated list. Check presence, not length: an empty array is just as final (e.g. only
        // already loaded tools were named), and falling back to input.name would record those names as activations.
        if (Array.isArray(metadata?.activatedTools)) {
          for (const name of stringsOf(metadata.activatedTools)) remember(name)
          continue
        }
        // Older single-tool format, still found in existing sessions.
        if (typeof metadata?.activatedTool === "string") {
          remember(metadata.activatedTool)
          continue
        }
        const inputName = typeof part.state.input.name === "string" ? part.state.input.name : ""
        for (const name of inputName.split(",")) remember(name)
        continue
      }
      // Any call to the tool, including a running one, restarts its idle count.
      lastSeen.set(part.tool, turn)
    }
  }

  const activated = new Set<string>()
  for (const name of everActivated) {
    if (turn - (lastSeen.get(name) ?? 0) <= ACTIVATION_IDLE_TURNS) activated.add(name)
  }
  return activated
}

/**
 * Whether an MCP tool is deferred. MCP.tools() sets the flag only when the server config says `deferred: true`.
 * Checked in one place so callers do not each cast with `as any`, where a misspelled property fails silently.
 */
export function isDeferredMcpTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && (tool as { __deferred?: unknown }).__deferred === true
}

/** First line of the description, or the id when there is none. */
function summaryOf(id: string, description?: string): string {
  return description?.split("\n")[0]?.trim() || id
}

/**
 * Full description of an MCP tool. MCP tools are defined by third parties and have no triggerHint, so the description
 * is their only signal: its capped first line is the summary (see mcpSummaryOf) and the full text is scored.
 */
function mcpDescriptionOf(tool: unknown): string | undefined {
  if (typeof tool !== "object" || tool === null) return undefined
  const description = (tool as { description?: unknown }).description
  return typeof description === "string" && description.trim() ? description : undefined
}

/**
 * Like {@link summaryOf}, but capped. Built-in descriptions have short first lines; third-party MCP descriptions
 * may open with a paragraph of hundreds of characters (codegraph_explore does), which would bloat deferred_tools on
 * every turn. The capped line is enough to say what the tool does; the query mode can narrow things down further.
 */
const MCP_SUMMARY_MAX = 120
function mcpSummaryOf(id: string, description?: string): string {
  const line = summaryOf(id, description)
  return line.length <= MCP_SUMMARY_MAX ? line : `${line.slice(0, MCP_SUMMARY_MAX - 1)}…`
}

export type DeferredPlan = {
  /** All deferred tools, activated ones included, so tool_search can look them up by name. */
  summaries: DeferredToolSummary[]
  /** Tools activated in history, including those carried by a compaction boundary. */
  activated: Set<string>
  /** Whether the tool is deferred and not yet activated, i.e. left out of this turn's tools array. */
  isPending(id: string): boolean
  /** Whether any deferred tool is still inactive; if not, tool_search is not injected. */
  hasPending: boolean
}

/**
 * Computes this turn's deferred loading plan. Shared by runner.resolveTools (which tools are sent) and
 * context-view.resolveToolStats (tool count and tokens in /context) so the two cannot drift apart.
 *
 * - Built-in tools: the deferred set comes from the agent config (Agent.computeDeferred).
 * - MCP tools: deferred only with an explicit `deferred: true` (see isDeferredMcpTool).
 *
 * Both are listed with id and a one-line summary; without a summary the model cannot tell what a tool is for and
 * never activates it.
 */
export function buildDeferredPlan(input: {
  standard: readonly { id: string; description?: string; triggerHint?: string }[]
  mcp: Record<string, unknown>
  deferredStandardIds: ReadonlySet<string>
  messages: Message.FullMsg[]
  /**
   * Whether the message-level `tools` switch disables the tool. Disabled tools are left out of the tool_search list,
   * since activating one would waste a round trip, but still count as deferred (isPending is true) so they stay out
   * of the tools array.
   */
  disabled?: (id: string) => boolean
}): DeferredPlan {
  const isDisabled = input.disabled ?? (() => false)
  const standardDeferred = input.standard.filter((t) => input.deferredStandardIds.has(t.id))
  const mcpDeferred = Object.entries(input.mcp).filter(([, tool]) => isDeferredMcpTool(tool))

  // Includes disabled tools: they must stay out of the tools array as well.
  const deferredIds = new Set<string>([...standardDeferred.map((t) => t.id), ...mcpDeferred.map(([id]) => id)])
  const summaries: DeferredToolSummary[] = [
    ...standardDeferred
      .filter((t) => !isDisabled(t.id))
      .map((t) => ({
        id: t.id,
        summary: summaryOf(t.id, t.description),
        triggerHint: t.triggerHint,
        // Scored only; the model still sees just the summary line.
        searchText: t.description,
      })),
    ...mcpDeferred
      .filter(([id]) => !isDisabled(id))
      .map(([id, tool]) => {
        const description = mcpDescriptionOf(tool)
        return { id, summary: mcpSummaryOf(id, description), searchText: description }
      }),
  ]
  const activated = scanActivatedTools(input.messages)

  return {
    summaries,
    activated,
    isPending: (id) => deferredIds.has(id) && !activated.has(id),
    hasPending: summaries.some((t) => !activated.has(t.id)),
  }
}

/**
 * Builds the tool_search meta tool.
 *
 * Its description lists the inactive deferred tools with id and a one-line summary. The model activates one by name,
 * and the next turn the runner adds its full schema to the tools array.
 *
 * - execute returns only a confirmation, not the schema, which arrives with the next turn's tools array.
 * - The query mode only suggests matches and activates nothing; it helps narrow down long MCP lists.
 * - Activated tools are hidden from the list so the model does not activate them twice.
 */
export function buildToolSearchTool(input: {
  deferred: DeferredToolSummary[]
  activated: Set<string>
  /**
   * Ids already in this turn's tools array. Activating one of them is a harmless no-op rather than an error:
   * subagents and models after compaction often pass loaded tool names, and an error would only cost a retry.
   */
  loaded?: ReadonlySet<string>
}): AITool {
  const { deferred, activated, loaded } = input
  const pending = deferred.filter((t) => !activated.has(t.id))

  const description = [
    "Discover and activate tools that are not loaded by default.",
    "",
    "If a skill or instruction tells you to use a tool but you cannot find it in your tool list, it is likely deferred - call this tool with that tool's exact `name` to activate it first.",
    "",
    "Some tools are deferred to save context: their full parameter schema is NOT in your tool list,",
    "only a one-line summary appears below. Call this tool with an exact `name` to activate one;",
    "it becomes available with full parameters in your NEXT turn (call it directly then, no need to call tool_search again).",
    'To activate several at once, pass a comma-separated list: `name: "pdf_parse,excel_write"` -- this costs one round trip instead of several.',
    "Alternatively pass a `query` to search deferred tools by name/summary before deciding.",
    "",
    pending.length > 0
      ? [
          "<deferred_tools>",
          ...pending.map((t) =>
            t.summary ? `  <tool name="${t.id}">${escapeXml(t.summary)}</tool>` : `  <tool name="${t.id}"/>`,
          ),
          "</deferred_tools>",
        ].join("\n")
      : "All deferred tools are already activated.",
  ].join("\n")

  return tool({
    description,
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Exact tool id to activate (see deferred_tools list above). Comma-separate to activate several in one call.",
        },
        query: {
          type: "string",
          description: "Search terms to discover matching deferred tools by name or summary",
        },
      },
    }),
    async execute(args: { name?: string; query?: string }) {
      const name = args.name?.trim()

      // Query mode: suggest matches without activating anything.
      if (!name) {
        const query = args.query?.trim() ?? ""
        const candidates = deferred.filter((t) => !activated.has(t.id))
        // Stage A scoring: id segments, CJK n-grams, weighted triggerHint and full description, so a Chinese query
        // for "spreadsheet" still finds excel_parse.
        const matches = query ? ToolDiscovery.rank({ candidates, query }).map((match) => match.tool) : candidates
        log.info("deferred tool search completed", {
          pending: candidates.length,
          matched: matches.length,
          queryProvided: query.length > 0,
        })
        return {
          title: query ? `tool search: ${query}` : "deferred tools",
          output: [
            `<tool_search_results query="${escapeXml(query)}" shown="${matches.length}">`,
            ...matches.map((t) =>
              t.summary ? `  <tool name="${t.id}">${escapeXml(t.summary)}</tool>` : `  <tool name="${t.id}"/>`,
            ),
            "</tool_search_results>",
            "",
            matches.length > 0
              ? "Call this tool again with the exact `name` of the best match to activate it for your next turn."
              : "No matching deferred tools.",
          ].join("\n"),
          metadata: { query, matched: matches.length } as Record<string, unknown>,
        }
      }

      // Name mode: activate. Activation only takes effect next turn, so a comma-separated list saves round trips.
      const requested = Array.from(
        new Set(
          name
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      )
      const activatedNow: string[] = []
      const alreadyAvailable: string[] = []
      const missing: string[] = []
      for (const id of requested) {
        if (deferred.some((t) => t.id === id)) {
          activatedNow.push(id)
          continue
        }
        // Already loaded: tell the model to call it directly instead of retrying.
        if (loaded?.has(id)) {
          alreadyAvailable.push(id)
          continue
        }
        missing.push(id)
      }

      // Nothing matched: return suggestions instead of throwing, which would send subagents and models after
      // compaction into a retry loop.
      if (activatedNow.length === 0 && alreadyAvailable.length === 0) {
        const suggestions = deferred.filter((t) => !activated.has(t.id)).slice(0, 10)
        log.warn("deferred tool activation missed", {
          requested: requested.length,
          missing: missing.length,
          suggestions: suggestions.length,
        })
        return {
          title: `Tool not found: ${missing.join(", ")}`,
          output: [
            `<tool_search_results query="${escapeXml(name)}" shown="${suggestions.length}">`,
            ...suggestions.map((t) =>
              t.summary ? `  <tool name="${t.id}">${escapeXml(t.summary)}</tool>` : `  <tool name="${t.id}"/>`,
            ),
            "</tool_search_results>",
            "",
            `No deferred tool named ${missing.map((id) => `"${id}"`).join(", ")}. Pick an exact name from the list above, or pass a \`query\` to search.`,
          ].join("\n"),
          metadata: { missing } as Record<string, unknown>,
        }
      }

      // metadata.activatedTools is what scanActivatedTools reads in later turns. The single activatedTool field is no
      // longer read here; it is kept so sessions imported into older versions still restore the activation.
      log.info("deferred tool activation completed", {
        activated: activatedNow,
        alreadyAvailable,
        missing: missing.length,
      })
      return {
        title: `Activated: ${[...activatedNow, ...alreadyAvailable].join(", ")}`,
        output: [
          ...activatedNow.map((id) =>
            [
              `<tool_activated name="${id}">`,
              `  ${deferred.find((t) => t.id === id)?.summary ?? ""}`,
              `  This tool is now available with full parameters in your next turn.`,
              `  Call it directly -- no need to call tool_search again for "${id}".`,
              `</tool_activated>`,
            ].join("\n"),
          ),
          ...alreadyAvailable.map(
            (id) => `<tool_already_available name="${id}">Call it directly.</tool_already_available>`,
          ),
          ...(missing.length ? [`<tool_not_found>${escapeXml(missing.join(", "))}</tool_not_found>`] : []),
        ].join("\n"),
        metadata: {
          activatedTools: activatedNow,
          activatedTool: activatedNow[0],
          ...(missing.length ? { missing } : {}),
        } as Record<string, unknown>,
      }
    },
  })
}
