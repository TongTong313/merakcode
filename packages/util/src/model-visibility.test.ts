import { describe, expect, test } from "vitest"
import { backendKey, isHidden, parseModelKeys, toggleHidden } from "./model-visibility"

describe("model-visibility", () => {
  test("backendKey joins with /", () => {
    expect(backendKey({ providerID: "anthropic", modelID: "claude-3" })).toBe("anthropic/claude-3")
  })

  test("parseModelKeys drops invalid entries", () => {
    expect(parseModelKeys(["a/b", "bad", "", "c/d"])).toEqual([
      { providerID: "a", modelID: "b" },
      { providerID: "c", modelID: "d" },
    ])
    expect(parseModelKeys(undefined)).toEqual([])
  })

  test("isHidden / toggleHidden", () => {
    const model = { providerID: "p", modelID: "a" }
    expect(isHidden(["p/a"], model)).toBe(true)
    expect(isHidden([], model)).toBe(false)
    expect(toggleHidden(["p/a"], model, true)).toEqual([])
    expect(toggleHidden([], model, false)).toEqual(["p/a"])
  })
})
