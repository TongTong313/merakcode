import { expect, test } from "vitest"
import { manualRow, modelConfig, rowOf, windowsValid } from "./relay-models"

test("a relay model with unknown windows starts with empty fields instead of guesses", () => {
  const row = rowOf({ id: "local-model", name: "local-model", endpoint: "openai-chat" })
  expect(row).toMatchObject({ id: "local-model", context: "", output: "", endpoint: "openai-chat", selected: true })
  expect(row.contextFrom).toBeUndefined()
})

test("a relay row is saved without made-up windows or capabilities", () => {
  const row = rowOf({ id: "local-model", name: "local-model", endpoint: "openai-chat" })
  expect(modelConfig(row, "@ai-sdk/openai-compatible")).toEqual({
    name: "local-model",
    provider: { npm: "@ai-sdk/openai-compatible" },
  })
})

test("known windows and capabilities are saved as found", () => {
  const row = rowOf({
    id: "claude-opus-4-8",
    name: "claude-opus-4-8",
    context: 1_000_000,
    output: 128000,
    contextFrom: "catalog",
    outputFrom: "catalog",
    input: ["text", "image"],
    reasoning: true,
    toolcall: true,
    endpoint: "anthropic",
  })
  expect(modelConfig({ ...row, output: "64000" }, "@ai-sdk/anthropic")).toEqual({
    name: "claude-opus-4-8",
    limit: { context: 1_000_000, output: 64000 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"] },
    provider: { npm: "@ai-sdk/anthropic" },
  })
})

test("a manually added model only guesses its protocol", () => {
  expect(manualRow("claude-private")).toEqual({
    id: "claude-private",
    context: "",
    output: "",
    endpoint: "anthropic",
    selected: true,
  })
  expect(manualRow("gpt-local").endpoint).toBe("openai-responses")
})

test("an empty window is allowed but a typed window must be a positive number", () => {
  const row = manualRow("local")
  expect(windowsValid(row)).toBe(true)
  expect(windowsValid({ ...row, context: "128000" })).toBe(true)
  expect(windowsValid({ ...row, context: "abc" })).toBe(false)
  expect(windowsValid({ ...row, output: "0" })).toBe(false)
})
