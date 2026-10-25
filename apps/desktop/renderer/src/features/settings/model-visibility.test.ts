import { expect, test } from "vitest"
import { nextPicker } from "./model-visibility"

test("turning a model on writes include and turning it off writes exclude", () => {
  const shown = nextPicker(undefined, "claude-opus-4-7", true)
  expect(shown).toEqual({ include: ["claude-opus-4-7"], exclude: [] })
  const hidden = nextPicker(shown, "claude-opus-4-7", false)
  expect(hidden).toEqual({ include: [], exclude: ["claude-opus-4-7"] })
  expect(nextPicker(hidden, "claude-opus-4-7", true)).toEqual({
    include: ["claude-opus-4-7"],
    exclude: [],
  })
})
