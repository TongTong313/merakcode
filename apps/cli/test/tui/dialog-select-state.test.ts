import { describe, expect, test } from "vitest"
import { findDialogSelectOptionIndex, findDialogSelectValueIndex } from "../../src/cli/cmd/tui/ui/dialog-select-state"

describe("findDialogSelectValueIndex", () => {
  test("finds the same selected value after options reorder", () => {
    const options = [
      { value: "session-pinned" },
      { value: "session-new" },
      { value: "session-unpinned" },
      { value: "session-old" },
    ]

    expect(findDialogSelectValueIndex(options, "session-unpinned")).toBe(2)
  })

  test("matches object values by deep equality", () => {
    const options = [
      { value: { providerID: "openai", modelID: "gpt-5.2" } },
      { value: { providerID: "anthropic", modelID: "claude" } },
    ]

    expect(findDialogSelectValueIndex(options, { providerID: "anthropic", modelID: "claude" })).toBe(1)
  })

  test("returns -1 when selected value is no longer present", () => {
    expect(findDialogSelectValueIndex([{ value: "session-a" }], "session-b")).toBe(-1)
  })

  test("returns -1 for undefined selected value", () => {
    expect(findDialogSelectValueIndex([{ value: "session-a" }], undefined)).toBe(-1)
  })

  test("finds pinned session after it moves to top section", () => {
    const before = [{ value: "session-new" }, { value: "session-target" }, { value: "session-old" }]
    const after = [
      { value: "session-pinned-a" },
      { value: "session-target" },
      { value: "session-new" },
      { value: "session-old" },
    ]

    expect(findDialogSelectValueIndex(before, "session-target")).toBe(1)
    expect(findDialogSelectValueIndex(after, "session-target")).toBe(1)
  })

  test("finds unpinned session after it leaves pinned section", () => {
    const pinned = [{ value: "session-target" }, { value: "session-new" }, { value: "session-old" }]
    const unpinned = [{ value: "session-new" }, { value: "session-target" }, { value: "session-old" }]

    expect(findDialogSelectValueIndex(pinned, "session-target")).toBe(0)
    expect(findDialogSelectValueIndex(unpinned, "session-target")).toBe(1)
  })
})

describe("findDialogSelectOptionIndex", () => {
  test("distinguishes rows with the same value", () => {
    const recent = { value: { providerID: "openai", modelID: "gpt-5.2" } }
    const provider = { value: { providerID: "openai", modelID: "gpt-5.2" } }
    const options = [recent, provider]

    expect(findDialogSelectOptionIndex(options, recent)).toBe(0)
    expect(findDialogSelectOptionIndex(options, provider)).toBe(1)
  })
})
