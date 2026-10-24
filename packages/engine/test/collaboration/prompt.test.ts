import { expect, test } from "vitest"
import { artifactLines } from "../../src/collaboration/prompt"

test("past forty changed files the rest are counted by directory", () => {
  const files = Array.from({ length: 42 }, (_, index) => ({ status: "M", path: `src/pay/file-${index}.ts` }))
  const lines = artifactLines(files).split("\n")
  expect(lines).toHaveLength(41)
  expect(lines.at(-1)).toBe("- … 2 more under src/pay")
  expect(artifactLines([])).toBe("none")
})
