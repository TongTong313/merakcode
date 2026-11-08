import { expect, test } from "vitest"
import type { CatalogModel } from "@merakcode/sdk"
import { manualRow, modelConfig, rowOf, windowsValid } from "./relay-models"

const unknown: CatalogModel = {
  id: "local-model",
  provider: "draft",
  window: 128000,
  maxOutput: 8192,
  price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  caps: { tools: false, vision: false, pdf: false },
  thinking: null,
  source: "live",
  unknown: ["window", "maxOutput", "price", "thinking", "caps"],
}

test("unknown limits stay empty and are omitted when saving", () => {
  const row = rowOf(unknown)
  expect(row).toMatchObject({ id: "local-model", context: "", output: "", selected: true })
  expect(modelConfig(row)).toEqual({ name: "local-model" })
})

test("published limits and edited output limits are saved", () => {
  const row = rowOf({ ...unknown, window: 96000, maxOutput: 16000, unknown: ["price", "thinking", "caps"] })
  expect(modelConfig({ ...row, output: "8000" })).toEqual({ name: "local-model", window: 96000, maxOutput: 8000 })
})

test.each(["0", "-1", "abc", "3.5", "Infinity"])("rejects invalid token limit %s", (context) => {
  expect(windowsValid({ ...manualRow("local"), context })).toBe(false)
})

test("manual limits may be empty but output cannot exceed the context window", () => {
  expect(windowsValid(manualRow("local"))).toBe(true)
  expect(windowsValid({ ...manualRow("local"), context: "8000", output: "16000" })).toBe(false)
})
