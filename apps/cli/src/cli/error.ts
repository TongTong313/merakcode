import { ErrorCode } from "@merakcode/util/error-code"
import { UI } from "./ui"

/** Engine errors: NamedError instances in-process, plain objects of the same shape over HTTP; both match by name */
type Named = {
  MCPFailed: { name: string }
  ProviderModelNotFoundError: { providerID: string; modelID: string; suggestions?: string[] }
  ProviderInitError: { providerID: string }
  ConfigJsonError: { path: string; message?: string }
  ConfigDirectoryTypoError: { path: string; dir: string; suggestion: string }
  ConfigFrontmatterError: { path: string; message: string }
  ConfigInvalidError: { path: string; message?: string; issues?: { message: string; path: PropertyKey[] }[] }
}

function is<K extends keyof Named>(input: unknown, name: K): input is { name: K; code?: string; data: Named[K] } {
  return typeof input === "object" && input !== null && "name" in input && input.name === name && "data" in input
}

function describe(input: unknown) {
  if (is(input, "MCPFailed")) return `MCP server "${input.data.name}" failed.`
  if (is(input, "ProviderModelNotFoundError")) {
    const { providerID, modelID, suggestions } = input.data
    return [
      `Model not found: ${providerID}/${modelID}`,
      ...(Array.isArray(suggestions) && suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      `Try: \`merak models\` to list available models`,
      `Or check your config (merakcode.json) provider/model names`,
    ].join("\n")
  }
  if (is(input, "ProviderInitError")) {
    return `Failed to initialize provider "${input.data.providerID}". Check credentials and configuration.`
  }
  if (is(input, "ConfigJsonError")) {
    return (
      `Config file at ${input.data.path} is not valid JSON(C)` + (input.data.message ? `: ${input.data.message}` : "")
    )
  }
  if (is(input, "ConfigDirectoryTypoError")) {
    return `Directory "${input.data.dir}" in ${input.data.path} is not valid. Rename the directory to "${input.data.suggestion}" or remove it. This is a common typo.`
  }
  if (is(input, "ConfigFrontmatterError")) {
    return input.data.message
  }
  if (is(input, "ConfigInvalidError"))
    return [
      `Configuration is invalid${input.data.path && input.data.path !== "config" ? ` at ${input.data.path}` : ""}` +
        (input.data.message ? `: ${input.data.message}` : ""),
      ...(input.data.issues?.map((issue) => "↳ " + issue.message + " " + issue.path.map(String).join(".")) ?? []),
    ].join("\n")
}

/** One readable message for a known engine error, prefixed with its error code, e.g. "[MRK-2002] Model not found" */
export function FormatError(input: unknown) {
  if (UI.CancelledError.isInstance(input)) return ""
  const text = describe(input)
  if (text === undefined) return
  const named = input as { name: string; code?: string; data?: unknown }
  return `[${named.code ?? ErrorCode.of(named.name, named.data)}] ${text}`
}
