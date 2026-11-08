import type { CatalogModel, ConfigModel } from "@merakcode/sdk"

export type Endpoint = "anthropic" | "openai"
export type RelayRow = {
  id: string
  context: string
  output: string
  contextFrom?: "relay" | "catalog"
  outputFrom?: "relay" | "catalog"
  selected: boolean
}

export function rowOf(model: CatalogModel): RelayRow {
  const context = !model.unknown?.includes("window")
  const output = !model.unknown?.includes("maxOutput")
  const source = model.source === "live" ? "relay" : "catalog"
  return {
    id: model.id,
    context: context ? String(model.window) : "",
    output: output ? String(model.maxOutput) : "",
    contextFrom: context ? source : undefined,
    outputFrom: output ? source : undefined,
    selected: true,
  }
}

export function manualRow(id: string): RelayRow {
  return { id, context: "", output: "", selected: true }
}

const limit = (value: string) => (value.trim() === "" ? undefined : Number(value))

export function windowsValid(row: RelayRow) {
  const context = limit(row.context)
  const output = limit(row.output)
  if (![context, output].every((value) => value === undefined || (Number.isSafeInteger(value) && value > 0)))
    return false
  return context === undefined || output === undefined || output <= context
}

export function modelConfig(row: RelayRow): ConfigModel {
  return {
    name: row.id,
    ...(row.context.trim() ? { window: Number(row.context) } : {}),
    ...(row.output.trim() ? { maxOutput: Number(row.output) } : {}),
  }
}
