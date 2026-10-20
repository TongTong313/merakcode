import type { Provider } from "./provider"

/** One models.dev reasoning_options entry, matching api.json */
export type ReasoningOption =
  { type: "toggle" } | { type: "effort"; values: string[] } | { type: "budget_tokens"; min?: number; max?: number }

/** Parsed summary of reasoning capabilities */
export type ReasoningCaps = {
  canToggle: boolean
  effortValues: string[]
  budget: { min?: number; max?: number } | null
}

/** Variant keys of the thinking toggle, shared by the UI switch and the TUI cycle */
export const TOGGLE_OFF = "off"
export const TOGGLE_ON = "on"

/** Parses reasoning capabilities from models.dev reasoning_options */
export function parseReasoning(options: ReasoningOption[] | undefined): ReasoningCaps {
  if (!options?.length) return { canToggle: false, effortValues: [], budget: null }

  let canToggle = false
  let effortValues: string[] = []
  let budget: ReasoningCaps["budget"] = null

  for (const opt of options) {
    if (opt.type === "toggle") canToggle = true
    if (opt.type === "effort") effortValues = opt.values
    if (opt.type === "budget_tokens") budget = { min: opt.min, max: opt.max }
  }

  return { canToggle, effortValues, budget }
}

/** Maps budget_tokens max to low/medium/high token budgets (25% / 50% / 100%, clamped to min) */
export function budgetTierValues(budget: { min?: number; max?: number }): Record<string, number> {
  const max = budget.max ?? budget.min ?? 0
  if (max <= 0) return {}
  const min = budget.min ?? 0
  const clamp = (n: number) => Math.max(min, n)
  return {
    low: clamp(Math.floor(max * 0.25)),
    medium: clamp(Math.floor(max * 0.5)),
    high: max,
  }
}

/**
 * Whether this is a Chinese provider (all on @ai-sdk/openai-compatible) whose thinking config is driven by models.dev
 * data with a known API format. The generic legacy logic (sending reasoningEffort) does nothing on their endpoints,
 * so they must bypass it.
 */
export function isNativeThinkingProvider(model: Provider.Model): boolean {
  if (model.api.npm !== "@ai-sdk/openai-compatible") return false
  // deepseek: the official API (api.deepseek.com) uses the thinking.type toggle (verified). Matching by providerID
  // only, so deepseek served by other providers (proxies, etc.) is unaffected.
  return ["alibaba-cn", "zhipuai", "zai", "moonshotai", "moonshotai-cn", "deepseek"].includes(model.providerID)
}

/**
 * Encodes variants from models.dev reasoning_options for Chinese providers whose parameters are known to work:
 * - alibaba-cn (DashScope): enable_thinking / thinking_budget (the endpoint ignores effort, so it is not sent)
 * - zhipuai / zai: thinking.type (with clear_thinking: false)
 * - moonshotai(-cn): thinking.type
 *
 * Other providers get {}: models.dev does not say the correct SDK parameter format, so no invalid parameters are sent.
 */
export function encodeVariantsFromReasoning(model: Provider.Model): Record<string, Record<string, unknown>> {
  if (!model.reasoning_options?.length) return {}
  if (!isNativeThinkingProvider(model)) return {}

  const caps = parseReasoning(model.reasoning_options)
  const providerID = model.providerID

  if (providerID === "alibaba-cn") return encodeDashScope(caps)
  if (providerID === "zhipuai" || providerID === "zai") return encodeThinkingToggle(caps, { clearThinking: true })
  return encodeThinkingToggle(caps, {})
}

/** DashScope: enable_thinking toggle plus thinking_budget tiers (DashScope ignores effort, so it is not sent) */
function encodeDashScope(caps: ReasoningCaps): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}

  if (caps.canToggle) result[TOGGLE_OFF] = { enable_thinking: false }

  if (caps.budget?.max || caps.budget?.min) {
    for (const [tier, budget] of Object.entries(budgetTierValues(caps.budget))) {
      result[tier] = { enable_thinking: true, thinking_budget: budget }
    }
    return result
  }

  if (caps.canToggle) result[TOGGLE_ON] = { enable_thinking: true }

  return result
}

/** Zhipu / Moonshot: thinking.type toggle (zhipuai also sends clear_thinking: false, matching options()) */
function encodeThinkingToggle(
  caps: ReasoningCaps,
  opts: { clearThinking?: boolean },
): Record<string, Record<string, unknown>> {
  if (!caps.canToggle) return {}
  return {
    [TOGGLE_OFF]: { thinking: { type: "disabled" } },
    [TOGGLE_ON]: { thinking: opts.clearThinking ? { type: "enabled", clear_thinking: false } : { type: "enabled" } },
  }
}
