import { describe, expect, test } from "vitest"
import { isFeedbackSubmit } from "../../src/cli/cmd/tui/routes/session/permission-feedback"

describe("permission feedback keyboard", () => {
  test("Enter and Return submit the feedback", () => {
    expect(isFeedbackSubmit({ name: "enter" })).toBe(true)
    expect(isFeedbackSubmit({ name: "return" })).toBe(true)
  })

  test("Shift+Enter keeps editing the feedback", () => {
    expect(isFeedbackSubmit({ name: "return", shift: true })).toBe(false)
  })
})
