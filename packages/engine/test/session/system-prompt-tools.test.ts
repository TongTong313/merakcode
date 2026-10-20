import { describe, expect, test } from "vitest"
import { SystemPrompt } from "@merakcode/engine/session/system"
import type { Provider } from "@merakcode/engine/provider/provider"

/** Minimal Model stub; SystemPrompt.provider only picks the prompt by api.id. */
function model(apiID: string): Provider.Model {
  return {
    providerID: "test",
    api: { id: apiID },
  } as Provider.Model
}

describe("SystemPrompt write tool guidance", () => {
  test("the gpt-5 prompt no longer mentions apply_patch", () => {
    const text = SystemPrompt.provider(model("gpt-5")).join("\n")
    expect(text).not.toContain("apply_patch")
    expect(text).toMatch(/edit|multi_edit|Write/i)
  })
})
