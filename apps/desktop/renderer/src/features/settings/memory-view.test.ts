import { expect, test } from "vitest"
import { kindKey, noteTitle } from "./memory-view"

test("a note is named by the first line of what it says, cut to a readable length", () => {
  expect(noteTitle("Use pnpm\nnot npm")).toBe("Use pnpm")
  expect(noteTitle("  \n\n  indented first line  \nmore")).toBe("indented first line")
  const long = "x".repeat(100)
  expect(noteTitle(long)).toBe("x".repeat(59) + "…")
  expect(noteTitle("")).toBe("")
})

test("each kind of note has its own label and an unknown kind has none", () => {
  expect(kindKey("fact")).toBe("settings.memory.fact")
  expect(kindKey("decision")).toBe("settings.memory.decision")
  expect(kindKey("preference")).toBe("settings.memory.preference")
  expect(kindKey("pitfall")).toBe("settings.memory.pitfall")
  expect(kindKey("other")).toBeUndefined()
})
