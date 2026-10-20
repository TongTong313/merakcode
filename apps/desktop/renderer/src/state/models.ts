import type { PermissionMode, UserMessage } from "@merakcode/sdk/client"
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

/** Composer choices, kept per conversation (per directory for a new conversation) */
type Choice = { model?: ModelRef; variant?: string; mode?: PermissionMode }
const [choices, setChoices] = createStore<Record<string, Choice>>({})

export const choiceKey = (sessionID: string | undefined, directory: string) => sessionID ?? `new:${directory}`

/** Model last used in the conversation */
function lastUsed(sessionID: string): Choice {
  const last = messagesOf(sessionID).findLast((message): message is UserMessage => message.role === "user")
  return last ? { model: last.model, variant: last.variant } : {}
}

export function choice(sessionID: string | undefined, directory: string) {
  const own = choices[choiceKey(sessionID, directory)] ?? {}
  const used = sessionID ? lastUsed(sessionID) : {}
  const model = own.model ?? used.model
  return {
    model: model && find(model) ? model : defaultModel(),
    variant: own.variant ?? used.variant,
    mode: (sessionID ? session(sessionID)?.permissionMode : undefined) ?? own.mode ?? state.mode,
  }
}

export function choose(sessionID: string | undefined, directory: string, patch: Choice) {
  const key = choiceKey(sessionID, directory)
  setChoices(key, (current) => ({ ...current, ...patch }))
}

type Usage = { tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }

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
  const replies = messagesOf(sessionID).filter((message) => message.role === "assistant")
  const last = replies.findLast((message) => contextTokens(message) > 0)
  if (!last) return
  const limit = find({ providerID: last.providerID, modelID: last.modelID })?.model.limit.context
  const tokens = contextTokens(last)
  return {
    tokens,
    limit,
    percent: limit ? Math.min(100, Math.round((tokens / limit) * 100)) : undefined,
    cost: replies.reduce((sum, message) => sum + message.cost, 0),
  }
}
