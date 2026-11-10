import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import { session, state } from "./store"

export type ModelRef = { providerID: string; modelID: string }
export const modelKey = (model: ModelRef) => `${model.providerID}/${model.modelID}`
const official = new Set(["openai", "anthropic", "deepseek", "moonshot", "zhipu", "dashscope", "gemini", "openrouter"])

export function available() {
  return state.models.flatMap((entry) => {
    const configured = state.config?.providers?.[entry.provider]
    if (!configured || configured.disabled || (!configured.hasKey && !configured.baseURL)) return []
    return [
      {
        key: `${entry.provider}/${entry.id}`,
        provider: {
          id: entry.provider,
          name: configured.name || entry.provider,
          origin: official.has(entry.provider) ? ("official" as const) : ("configured" as const),
        },
        model: {
          ...entry,
          name: configured.models?.[entry.id]?.name || entry.id,
          homepage: !configured.picker?.exclude?.includes(entry.id),
        },
      },
    ]
  })
}

export function find(model: ModelRef | undefined) {
  if (!model) return
  return available().find((entry) => entry.key === modelKey(model))
}

function parse(value?: string): ModelRef | undefined {
  if (!value) return
  const at = value.indexOf("/")
  if (at < 1 || at === value.length - 1) return
  return { providerID: value.slice(0, at), modelID: value.slice(at + 1) }
}

function defaultModel() {
  const configured = parse(state.config?.model)
  if (find(configured)) return configured
  const first = available()[0]
  return first ? { providerID: first.provider.id, modelID: first.model.id } : undefined
}

export function shownDefaultModel() {
  const model = defaultModel()
  return model && modelKey(model)
}

type Choice = { model?: ModelRef; thinking?: Record<string, string>; mode?: "ask" | "auto" | "takeover" }
const [choices, setChoices] = createStore<Record<string, Choice>>({})
export const choiceKey = (id: string | undefined, directory: string) => id ?? `new:${directory}`

export function choice(id: string | undefined, directory: string) {
  const own = choices[choiceKey(id, directory)]
  const config = id ? session(id)?.config : undefined
  const selected = own?.model ?? (config ? { providerID: config.provider, modelID: config.model } : undefined)
  const model = find(selected) ? selected : defaultModel()
  const levels = find(model)?.model.thinking ?? []
  const saved = model ? own?.thinking?.[modelKey(model)] : undefined
  const sameModel = config?.provider === model?.providerID && config?.model === model?.modelID
  const requested = saved ?? (sameModel ? config?.thinking : undefined) ?? state.config?.thinking
  const requestedMode = config?.mode ?? own?.mode ?? state.config?.mode
  const mode: "ask" | "auto" | "takeover" =
    requestedMode === "takeover" || requestedMode === "auto" ? requestedMode : "ask"
  return { model, mode, variant: requested && (!levels.length || levels.includes(requested)) ? requested : levels[0] }
}

export function choose(
  id: string | undefined,
  directory: string,
  patch: { model?: ModelRef; variant?: string; mode?: "ask" | "auto" | "takeover" },
) {
  const key = choiceKey(id, directory)
  const target = patch.model ?? choice(id, directory).model
  batch(() => {
    if (!choices[key]) setChoices(key, {})
    if (patch.mode) setChoices(key, "mode", patch.mode)
    if (patch.model && modelKey(patch.model) !== (choices[key]?.model && modelKey(choices[key]!.model!)))
      setChoices(key, "model", patch.model)
    if (patch.variant === undefined || !target) return
    setChoices(key, "thinking", { ...choices[key]?.thinking, [modelKey(target)]: patch.variant })
  })
}

export function usage(id: string) {
  const view = state.views[id]
  if (!view) return
  const budget = view.budget
  const tokens = budget?.total ?? view.state.usage.input + view.state.usage.output
  const limit =
    budget?.window ?? find({ providerID: view.state.config.provider, modelID: view.state.config.model })?.model.window
  const usage = view.state.usage
  return {
    tokens,
    limit,
    percent: limit ? Math.min(100, Math.round((tokens / limit) * 100)) : undefined,
    costs: usage.costKnown && usage.currency ? { [usage.currency]: usage.cost } : {},
  }
}
