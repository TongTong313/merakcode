import type { Config, ProviderRelayDiscoverResponses } from "@merakcode/sdk/client"

type Found = Extract<ProviderRelayDiscoverResponses[200], { models: unknown }>["models"][number]
export type Endpoint = NonNullable<Found["endpoint"]>
type ConfigModel = NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string]

/** One editable row of the relay dialog. Empty windows and absent capabilities mean "not stated". */
export type RelayRow = Pick<Found, "id" | "contextFrom" | "outputFrom" | "input" | "reasoning" | "toolcall"> & {
  context: string
  output: string
  endpoint: Endpoint
  selected: boolean
}

export function rowOf(model: Found): RelayRow {
  return {
    id: model.id,
    context: model.context === undefined ? "" : String(model.context),
    output: model.output === undefined ? "" : String(model.output),
    contextFrom: model.contextFrom,
    outputFrom: model.outputFrom,
    endpoint: model.endpoint ?? "openai-chat",
    input: model.input,
    reasoning: model.reasoning,
    toolcall: model.toolcall,
    selected: true,
  }
}

/** A model typed by hand: only the protocol is guessed from its name. */
export function manualRow(id: string): RelayRow {
  const name = id.toLowerCase()
  const endpoint: Endpoint = name.includes("claude")
    ? "anthropic"
    : name.includes("gpt") || name.includes("codex")
      ? "openai-responses"
      : "openai-chat"
  return { id, context: "", output: "", endpoint, selected: true }
}

const window = (value: string) => (value.trim() === "" ? undefined : Number(value))

export function windowsValid(row: RelayRow) {
  return [row.context, row.output].every((value) => {
    const number = window(value)
    return number === undefined || (Number.isFinite(number) && number > 0)
  })
}

/** Saves only what the station, the catalog or the user stated, so the engine can fill the rest. */
export function modelConfig(row: RelayRow, npm: string): ConfigModel {
  const context = window(row.context)
  const output = window(row.output)
  const model: ConfigModel = { name: row.id, provider: { npm } }
  if (context !== undefined || output !== undefined) model.limit = { context, output }
  if (row.reasoning !== undefined) model.reasoning = row.reasoning
  if (row.toolcall !== undefined) model.tool_call = row.toolcall
  if (row.input) model.modalities = { input: row.input }
  return model
}
