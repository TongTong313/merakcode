import { expect, test } from "vitest"
import EXIT_DESCRIPTION from "./plan-exit.txt"

test("submitting a plan stops for human review without a timeout or mode change", () => {
  expect(EXIT_DESCRIPTION).toMatch(/review/i)
  expect(EXIT_DESCRIPTION).toMatch(/does not switch/i)
  expect(EXIT_DESCRIPTION).toMatch(/stop/i)
})
