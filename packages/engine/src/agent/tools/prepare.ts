import type { Session } from "../session"
import type { Message } from "../session/message"
import { Agent, STANDARD_TOOL_POOL, computeDeferred } from "../agent"
import type { Provider } from "../model/provider"
import { MCP } from "../mcp"
import { ToolRegistry } from "./registry"
import { buildDeferredPlan, buildToolSearchTool } from "./tool-search"
import { ToolDiscovery } from "./tool-discovery"
import { ToolDiscoveryRerank } from "./tool-discovery-rerank"
import { SkillSearch } from "../skill/search"
import { PermissionMode } from "../permission/mode"

export async function prepareTools(input: {
  agent: Agent.Info
  model: Provider.Model
  session: Pick<Session.Info, "id" | "parentID" | "metadata">
  messages: Message.FullMsg[]
  tools?: Record<string, boolean>
  permissionMode?: PermissionMode.Value
  child?: boolean
  step?: number
  discover?: boolean
}) {
  const childSession = Boolean(input.session.parentID) || input.child === true
  const effectivePermissionMode = input.permissionMode ?? PermissionMode.DEFAULT
  const pool = new Set(input.agent.profile?.availableTools ?? STANDARD_TOOL_POOL)
  const allowMcp = pool.has("mcp")

  // The MCP tool list does not change within one resolveTools call, so fetch it once instead of repeating listTools
  // round trips. Agents whose pool lacks "mcp" (narrow pools such as compaction or memory-extractor) skip it.
  const mcpTools = allowMcp ? await MCP.tools() : {}
  // Server names for expandMcpServerActivation come from the clients actually connected in this process, not every
  // configured server: tools of disabled or failed servers are not in mcpTools anyway. clients() only holds live
  // connections and is the same source MCP.tools() uses.
  const mcpServerNames = allowMcp ? Object.keys(await MCP.clients()) : []
  const standardTools = await ToolRegistry.tools(
    { modelID: input.model.api.id, providerID: input.model.providerID },
    input.agent,
  )

  // Deferred loading: deferred tools stay out of the tools array, saving the per-turn token cost of their full
  // description and parameter schema; tool_search only lists their names and summaries. buildDeferredPlan is shared
  // with context-view.resolveToolStats so /context counts the same tool set that is injected here.
  const deferred = buildDeferredPlan({
    standard: standardTools,
    mcp: mcpTools,
    deferredStandardIds: computeDeferred(input.agent),
    messages: input.messages,
    disabled: (id) => input.tools?.[id] === false,
  })

  // Tools removed outright: child sessions cannot nest workflows. Computed here because auto-activation must skip
  // them too; activating a tool that is later removed would point the model at a tool that does not exist.
  const physicallyHidden = new Set<string>()
  if (childSession) physicallyHidden.add("workflow_run")

  // Map the query to tools worth activating. Otherwise deferred tools only show up by name in the tool_search
  // description and the model must find them itself; e.g. asked to "use a workflow for the research", the model read
  // "workflow" as "work step by step", used todowrite, and never activated workflow_run.
  //
  // Two stages, both run only while some tools are still inactive this turn:
  // - Stage A (deterministic scoring, on by default): strong matches are activated right away and get their full
  //   schema this turn. Activation through tool_search only takes effect next turn (there is no same-turn expansion
  //   like Anthropic's tool_reference), and that round trip is expensive, so confident matches skip it.
  // - Stage B (small model selection, off by default): only runs with many candidates (mostly many MCP tools);
  //   timeouts and failures select nothing and never block the turn.
  const autoActivated: string[] = []
  if (
    input.discover !== false &&
    deferred.hasPending &&
    (input.step ?? 1) === 1 &&
    (await ToolDiscovery.autoActivateEnabled())
  ) {
    const query = SkillSearch.latestUserText(input.messages)
    const candidates = deferred.summaries.filter(
      (item) => !deferred.activated.has(item.id) && !physicallyHidden.has(item.id),
    )
    const matches = ToolDiscovery.rank({ candidates, query })
    // Activate MCP servers as a whole: a strong match on any tool of a server activates all of its pending tools.
    // The top-2 cap in autoActivateIds once left a knowledge base server with only two write tools, so the model
    // concluded it could not query and abandoned it. With the whole server visible, the model picks query, write
    // and admin tools from their descriptions. serverNames are the connected clients (mcpServerNames above), the
    // same source as mcpIds.
    autoActivated.push(
      ...ToolDiscovery.expandMcpServerActivation({
        selected: ToolDiscovery.autoActivateIds(matches),
        candidates,
        mcpIds: new Set(Object.keys(mcpTools)),
        serverNames: mcpServerNames,
      }),
    )

    // Stage B: ask the small model only when Stage A found no strong match and the candidate pool is large (mostly
    // many MCP tools). The threshold uses all pending candidates, not Stage A's shortlist; otherwise a case like
    // 50 candidates with only 5 weak keyword hits, which most needs the small model, would be filtered out.
    if (
      autoActivated.length === 0 &&
      candidates.length >= ToolDiscoveryRerank.MIN_CANDIDATES &&
      (await ToolDiscovery.rerankEnabled())
    ) {
      const picked = await ToolDiscoveryRerank.select({
        query,
        // Send the weak matches (sorted by relevance) if any, else all candidates (truncated internally).
        candidates: matches.length > 0 ? matches.map((match) => match.tool) : candidates,
        fallbackProviderID: input.model.providerID,
      }).catch(() => [])
      autoActivated.push(...picked.filter((id) => !physicallyHidden.has(id)))
    }

    // isPending reads this set, so the loop below builds the newly activated tools normally.
    for (const id of autoActivated) deferred.activated.add(id)
  }

  const dynamic = await ToolRegistry.dynamicIds()
  const mcpIds = new Set(Object.keys(mcpTools))
  function visible(id: string) {
    if (id === "invalid") return true
    if (input.tools?.[id] === false) return false
    if (mcpIds.has(id)) return allowMcp
    if (!pool.has(id) && !(pool.has("plugin") && dynamic.has(id))) return false
    if (id === "delegate" && input.session.metadata?.group !== true) return false
    if (effectivePermissionMode === "auto" && (id === "question" || id === "plan_enter")) return false
    if (id === "plan_enter" && effectivePermissionMode === "readonly") return false
    if (id === "plan_exit" && effectivePermissionMode !== "readonly") return false
    if (childSession && ["subagent", "workflow_run", "plan_enter", "plan_exit"].includes(id)) return false
    return true
  }
  function search(loaded: Set<string>) {
    const candidates = deferred.summaries.filter(
      (item) => !physicallyHidden.has(item.id) && (!deferred.activated.has(item.id) || loaded.has(item.id)),
    )
    if (!candidates.some((item) => !deferred.activated.has(item.id))) return undefined
    return buildToolSearchTool({ deferred: candidates, activated: deferred.activated, loaded })
  }
  return { standardTools, mcpTools, mcpServerNames, mcpIds, dynamic, deferred, autoActivated, visible, search }
}
