import { describe, expect, test } from "vitest"
import { modelSections } from "../../src/cli/cmd/tui/component/dialog-model-state"

describe("modelSections", () => {
  const model = { providerID: "openai", modelID: "gpt-5.2" }

  test("keeps a recent model in its provider section", () => {
    expect(modelSections(true, [], [model], model)).toEqual({
      recent: true,
      provider: true,
    })
  })

  test("preserves favorite section precedence", () => {
    expect(modelSections(true, [model], [model], model)).toEqual({
      recent: false,
      provider: false,
    })
    expect(modelSections(false, [model], [model], model)).toEqual({
      recent: false,
      provider: true,
    })
  })
})
