import { describe, expect, test } from "vitest"
import { FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"

// Engine errors arrive as plain { name, code, data } objects over HTTP and as NamedError instances in-process
describe("FormatError", () => {
  test("model not found: starts with the error code, lists candidates and says how to look them up", () => {
    const text = FormatError({
      name: "ProviderModelNotFoundError",
      data: { providerID: "alibaba-cn", modelID: "qwen-max", suggestions: ["qwen-plus", "qwen3-max"] },
    })
    expect(text).toContain("[MRK-2002] Model not found: alibaba-cn/qwen-max")
    expect(text).toContain("Did you mean: qwen-plus, qwen3-max")
    expect(text).toContain("merak models")
  })

  test("invalid config: shows where and every issue", () => {
    const text = FormatError({
      name: "ConfigInvalidError",
      data: { path: "/home/me/merakcode.json", issues: [{ message: "Expected string", path: ["model"] }] },
    })
    expect(text).toBe("[MRK-3002] Configuration is invalid at /home/me/merakcode.json\n↳ Expected string model")
  })

  test("other named errors get one line each, and a code sent by the engine wins", () => {
    expect(FormatError({ name: "MCPFailed", data: { name: "github" } })).toBe('[MRK-6001] MCP server "github" failed.')
    expect(FormatError({ name: "ConfigJsonError", code: "MRK-3001", data: { path: "a.json", message: "bad" } })).toBe(
      "[MRK-3001] Config file at a.json is not valid JSON(C): bad",
    )
    expect(FormatError({ name: "ConfigFrontmatterError", data: { path: "a.md", message: "no end" } })).toBe(
      "[MRK-3004] no end",
    )
    expect(FormatError({ name: "ProviderInitError", data: { providerID: "openai" } })).toContain('"openai"')
  })

  test("cancellation prints nothing; unknown errors are left to the fallback formatter", () => {
    expect(FormatError(new UI.CancelledError())).toBe("")
    expect(FormatError(new Error("boom"))).toBeUndefined()
    expect(FormatError(null)).toBeUndefined()
  })
})
