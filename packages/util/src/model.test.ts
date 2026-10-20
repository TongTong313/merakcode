import { expect, test } from "vitest"
import { parseModel, sortModels } from "./model"

test("parseModel: the model name may contain further slashes", () => {
  expect(parseModel("openrouter/anthropic/claude-sonnet-4")).toEqual({
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-4",
  })
})

test("sortModels: models without tool calls and deprecated ones go last; the rest are newest first", () => {
  const model = (id: string, toolcall: boolean, release_date: string, status = "active") => ({
    id,
    release_date,
    status,
    capabilities: { toolcall },
  })
  const sorted = sortModels([
    model("zzz-intent-detect", false, "2026-01-01"),
    model("old-chat", true, "2024-01-01"),
    model("deprecated-chat", true, "2026-06-01", "deprecated"),
    model("new-chat", true, "2025-09-01"),
  ])
  expect(sorted.map((item) => item.id)).toEqual(["new-chat", "old-chat", "deprecated-chat", "zzz-intent-detect"])
})

test("sortModels: later preferences win, and latest wins within the same preference", () => {
  const sorted = sortModels([
    { id: "random-model" },
    { id: "claude-sonnet-4-latest" },
    { id: "gemini-3-pro-latest" },
    { id: "other-model" },
  ])
  expect(sorted.map((item) => item.id)).toEqual([
    "gemini-3-pro-latest",
    "claude-sonnet-4-latest",
    "random-model",
    "other-model",
  ])
})

test("sortModels: stable aliases rank above preferences", () => {
  expect(sortModels([{ id: "claude-sonnet-4" }, { id: "qwen-plus" }])[0]!.id).toBe("qwen-plus")
})
