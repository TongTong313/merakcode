import type { AssistantMessage, PermissionMode, UserMessage } from "@merakcode/sdk/client"
import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import { messagesOf, session, state } from "./store"

export type ModelRef = { providerID: string; modelID: string }

/** Parses "provider/model", splitting at the first "/" only since model ids may contain "/" too */
function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return
  const at = value.indexOf("/")
  if (at <= 0) return
  return { providerID: value.slice(0, at), modelID: value.slice(at + 1) }
}

export const modelKey = (model: ModelRef) => `${model.providerID}/${model.modelID}`

/** Models of the connected providers */
export function available() {
  const providers = state.providers
  if (!providers) return []
  const connected = new Set(providers.connected)
  return providers.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models)
        .filter((model) => model.status !== "deprecated")
        .map((model) => ({ provider, model, key: `${provider.id}/${model.id}` })),
    )
}

export function find(model: ModelRef | undefined) {
  if (!model) return
  return available().find((item) => item.provider.id === model.providerID && item.model.id === model.modelID)
}

/** The model from the config, otherwise the default model of the first connected provider */
function defaultModel(): ModelRef | undefined {
  const configured = parseModel(state.config?.model)
  if (configured && find(configured)) return configured
  const providers = state.providers
  if (!providers) return
  for (const id of providers.connected) {
    const model = providers.default[id]
    if (model && find({ providerID: id, modelID: model })) return { providerID: id, modelID: model }
  }
  const first = available()[0]
  return first ? { providerID: first.provider.id, modelID: first.model.id } : undefined
}

/** Model key shown in the default-model setting. A new conversation uses this same model. */
export function shownDefaultModel(): string | undefined {
  const model = defaultModel()
  return model ? modelKey(model) : undefined
}

/** Model key shown in the small-model setting. Empty when nothing usable is configured. */
export function shownSmallModel(): string | undefined {
  const parsed = parseModel(state.config?.small_model)
  if (parsed && find(parsed)) return modelKey(parsed)
}

/** Composer choices, kept per conversation (per directory for a new conversation) */
type Choice = { model?: ModelRef; variantByModel?: Record<string, string>; mode?: PermissionMode }
const [choices, setChoices] = createStore<Record<string, Choice>>({})

export const choiceKey = (sessionID: string | undefined, directory: string) => sessionID ?? `new:${directory}`

/** Model last used in the conversation */
function lastUsed(sessionID: string): { model?: ModelRef } {
  const last = messagesOf(sessionID).findLast(
    (message): message is UserMessage => message.role === "user" && "model" in message,
  )
  return last ? { model: last.model } : {}
}

/** Level last sent with this model, ignoring every other model's messages. */
function sentVariant(sessionID: string, model: ModelRef) {
  const last = messagesOf(sessionID).findLast(
    (message): message is UserMessage =>
      message.role === "user" &&
      "model" in message &&
      message.model.providerID === model.providerID &&
      message.model.modelID === model.modelID &&
      !!message.variant,
  )
  return last?.variant
}

export function choice(sessionID: string | undefined, directory: string) {
  const own = choices[choiceKey(sessionID, directory)] ?? {}
  const used = sessionID ? lastUsed(sessionID) : {}
  const model = own.model ?? used.model
  const resolved = model && find(model) ? model : defaultModel()
  const stored = resolved ? own.variantByModel?.[modelKey(resolved)] : undefined
  const sent = resolved && sessionID ? sentVariant(sessionID, resolved) : undefined
  const official = resolved ? find(resolved)?.model.defaultVariant : undefined
  return {
    model: resolved,
    variant: stored ?? sent ?? official,
    mode: (sessionID ? session(sessionID)?.permissionMode : undefined) ?? own.mode ?? state.mode,
  }
}

/**
 * Writes only what changed: selects call onChange again whenever their options are rebuilt, and a write of an equal
 * value must not notify, or the select and this store would update each other forever.
 */
export function choose(sessionID: string | undefined, directory: string, patch: Choice & { variant?: string }) {
  const key = choiceKey(sessionID, directory)
  const target = patch.model ?? choice(sessionID, directory).model
  batch(() => {
    if (!choices[key]) setChoices(key, {})
    if (patch.mode) setChoices(key, "mode", patch.mode)
    const current = choices[key]!.model
    if (patch.model && (!current || modelKey(current) !== modelKey(patch.model))) setChoices(key, "model", patch.model)
    if (patch.variant === undefined || !target) return
    if (!choices[key]!.variantByModel) setChoices(key, "variantByModel", {})
    setChoices(key, "variantByModel", modelKey(target), patch.variant)
  })
}

type Usage = {
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  cost: number
  providerID: string
  modelID: string
}

/** Tokens in context after a reply: input (with cache) plus this reply's output and reasoning, all sent next turn */
const contextTokens = (message: Usage) =>
  message.tokens.input +
  message.tokens.output +
  message.tokens.reasoning +
  message.tokens.cache.read +
  message.tokens.cache.write

/**
 * Context usage of a conversation: the share of the model's context window used by the latest reply with usage data;
 * cost is summed over all replies
 */
export function usage(sessionID: string) {
  const replies = messagesOf(sessionID).filter(
    (message): message is AssistantMessage => message.role === "assistant" && "tokens" in message,
  )
  const last = replies.findLast((message) => contextTokens(message) > 0)
  if (!last) return
  const limit = find({ providerID: last.providerID, modelID: last.modelID })?.model.limit.context
  const tokens = contextTokens(last)
  const costs: Record<string, number> = {}
  for (const message of replies) {
    if (message.role !== "assistant") continue
    const priced = find({ providerID: message.providerID, modelID: message.modelID })?.model.cost
    if (!priced) continue
    const currency = priced.currency ?? "USD"
    costs[currency] = (costs[currency] ?? 0) + message.cost
  }
  return {
    tokens,
    limit,
    percent: limit ? Math.min(100, Math.round((tokens / limit) * 100)) : undefined,
    costs,
  }
}
