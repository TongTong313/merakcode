import { Token } from "../util/token"
import { Message } from "./message"
import { SessionToolInput } from "./tool-input"
import { SessionToolResult } from "./tool-result"

export namespace SessionContextBudget {
  export const TOOL_RESULT_PLACEHOLDER = SessionToolResult.PLACEHOLDER
  export const TOOL_RESULT_BUDGET = 40_000
  export const RECENT_TURNS = 2
  export const MICROCOMPACT_KEEP_RESULTS = 16
  export const MICROCOMPACT_TRIGGER_RESULTS = 24

  // Tool input truncation has its own budget, derived from the usable window: clamp(usable * share, min, max)
  export const TOOL_INPUT_BUDGET_SHARE = 0.1
  export const TOOL_INPUT_BUDGET_MIN = 4_000
  export const TOOL_INPUT_BUDGET_MAX = 20_000
  /** Max characters kept per content field, roughly the size of a typical file passed to write */
  export const TOOL_INPUT_MAX_CHARS_PER_FIELD = 4_000

  export type Count = {
    count: number
    tokens: number
  }

  /** User config for input_budget: a boolean or an object. On by default with the dynamic budget. */
  export type InputBudgetUserConfig =
    | boolean
    | {
        enabled?: boolean
        share?: number
        min?: number
        max?: number
        max_chars_per_field?: number
      }

  /** Resolves the input budget config against the usable window: enabled flag, budget and per-field limit. */
  export function resolveInputBudgetConfig(
    usable: number,
    config: InputBudgetUserConfig | undefined,
  ): { enabled: boolean; budget: number; maxCharsPerField: number } {
    const object = typeof config === "object" ? config : undefined
    const configuredEnabled = typeof config === "boolean" ? config : object?.enabled
    if (configuredEnabled === false) {
      return { enabled: false, budget: 0, maxCharsPerField: TOOL_INPUT_MAX_CHARS_PER_FIELD }
    }
    const share = object?.share ?? TOOL_INPUT_BUDGET_SHARE
    const min = object?.min ?? TOOL_INPUT_BUDGET_MIN
    const max = object?.max ?? TOOL_INPUT_BUDGET_MAX
    const budget = Math.max(min, Math.min(max, Math.floor(usable * share)))
    return {
      enabled: true,
      budget,
      maxCharsPerField: object?.max_chars_per_field ?? TOOL_INPUT_MAX_CHARS_PER_FIELD,
    }
  }

  export type Stats = {
    budget: number
    recentTurns: number
    microcompact: {
      keep: number
      trigger: number
      active: boolean
    }
    original: Count
    kept: Count
    recent: Count
    protected: Count
    alreadyCleared: Count
    budgetCleared: Count
    microcompactCleared: Count
    /** Tool input truncation */
    input: {
      enabled: boolean
      budget: number
      maxCharsPerField: number
      truncated: Count
    }
  }

  type Entry = {
    part: Message.ToolPart
    tokens: number
  }

  export function applyToProjection(input: {
    messages: Message.FullMsg[]
    budget?: number
    recentTurns?: number
    microcompactKeep?: number
    microcompactTrigger?: number
    now?: number
    /** Tool input budget, already resolved against the usable window. 0 or omitted disables input truncation. */
    inputBudget?: number
    /** Max characters kept per content field */
    inputMaxChars?: number
  }): Stats {
    const budget = input.budget ?? TOOL_RESULT_BUDGET
    const recentTurns = input.recentTurns ?? RECENT_TURNS
    const microcompactKeep = input.microcompactKeep ?? MICROCOMPACT_KEEP_RESULTS
    const microcompactTrigger = input.microcompactTrigger ?? MICROCOMPACT_TRIGGER_RESULTS
    const now = input.now ?? Date.now()
    const inputBudget = input.inputBudget ?? 0
    const inputMaxChars = input.inputMaxChars ?? TOOL_INPUT_MAX_CHARS_PER_FIELD
    const stats: Stats = {
      budget,
      recentTurns,
      microcompact: {
        keep: microcompactKeep,
        trigger: microcompactTrigger,
        active: false,
      },
      original: empty(),
      kept: empty(),
      recent: empty(),
      protected: empty(),
      alreadyCleared: empty(),
      budgetCleared: empty(),
      microcompactCleared: empty(),
      input: {
        enabled: inputBudget > 0,
        budget: inputBudget,
        maxCharsPerField: inputMaxChars,
        truncated: empty(),
      },
    }
    const candidates: Entry[] = []
    let turns = 0

    for (let messageIndex = input.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const msg = input.messages[messageIndex]
      if (msg.info.role === "user") turns++

      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type !== "tool" || part.state.status !== "completed") continue

        const tokens = Token.estimate(part.state.output)
        add(stats.original, tokens)

        if (part.state.time.compacted || part.state.output === TOOL_RESULT_PLACEHOLDER) {
          add(stats.alreadyCleared, tokens)
          continue
        }
        if (SessionToolResult.isProtected(part.tool)) {
          add(stats.protected, tokens)
          add(stats.kept, tokens)
          continue
        }
        if (turns < recentTurns) {
          add(stats.recent, tokens)
          add(stats.kept, tokens)
          continue
        }

        candidates.push({ part, tokens })
      }
    }

    let budgetTokens = 0
    const survivors: Entry[] = []
    for (const entry of candidates) {
      if (budgetTokens + entry.tokens <= budget) {
        budgetTokens += entry.tokens
        survivors.push(entry)
        continue
      }
      clear(entry, stats.budgetCleared, now)
    }

    stats.microcompact.active = survivors.length > microcompactTrigger
    for (let i = 0; i < survivors.length; i++) {
      const entry = survivors[i]
      if (stats.microcompact.active && i >= microcompactKeep) {
        clear(entry, stats.microcompactCleared, now)
        continue
      }
      add(stats.kept, entry.tokens)
    }

    // Separate input budget: sum content-field tokens over the candidates and truncate content fields (keeping
    // filePath/path) once over budget. Independent of output clearing in both directions. Parts inside the protected
    // window (recentTurns) are never candidates, so the model keeps the context it just produced.
    if (inputBudget > 0) {
      let inputTokens = 0
      for (const entry of candidates) {
        const fieldTokens = SessionToolInput.estimateTokens(entry.part)
        if (inputTokens + fieldTokens <= inputBudget) {
          inputTokens += fieldTokens
          continue
        }
        if (SessionToolInput.truncate(entry.part, inputMaxChars)) {
          add(stats.input.truncated, fieldTokens)
        }
      }
    }

    return stats
  }

  function clear(entry: Entry, target: Count, now: number) {
    add(target, entry.tokens)
    if (entry.part.state.status !== "completed") return
    entry.part.state.output = TOOL_RESULT_PLACEHOLDER
    entry.part.state.attachments = []
    entry.part.state.time.compacted = now
  }

  function empty(): Count {
    return {
      count: 0,
      tokens: 0,
    }
  }

  function add(target: Count, tokens: number) {
    target.count++
    target.tokens += tokens
  }
}
