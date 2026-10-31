import { describe, expect, test } from "vitest"
import { buildInlineEditPrompt, cleanInlineEditResult, validateInlineEditBody } from "./inline-edit"

describe("buildInlineEditPrompt", () => {
  test("includes the instruction, selection and language, and asks for code only", () => {
    const { system, prompt } = buildInlineEditPrompt({
      instruction: "改成 async",
      selectedText: "function f() {}",
      language: "typescript",
      path: "/d/a.ts",
    })
    expect(system).toContain("Output only the complete code that replaces the selection")
    expect(prompt).toContain("改成 async")
    expect(prompt).toContain("function f() {}")
    expect(prompt).toContain("typescript")
    expect(prompt).toContain("/d/a.ts")
  })

  test("writes new comments in the UI language: Chinese by default, English for en", () => {
    const input = { instruction: "add a comment", selectedText: "f()" }
    expect(buildInlineEditPrompt(input).system).toContain("write new comments in Chinese")
    expect(buildInlineEditPrompt(input, "en").system).toContain("write new comments in English")
  })
})

describe("cleanInlineEditResult", () => {
  test("strips markdown fences", () => {
    expect(cleanInlineEditResult("```ts\nconst x = 1\n```", "old")).toBe("const x = 1")
  })

  test("falls back to the selection on empty output", () => {
    expect(cleanInlineEditResult("   ", "original")).toBe("original")
  })

  test("keeps unfenced output, trimming surrounding blank lines", () => {
    expect(cleanInlineEditResult("\nfoo()\n\n", "x")).toBe("foo()")
  })
})

describe("validateInlineEditBody", () => {
  test("accepts a valid body", () => {
    expect(validateInlineEditBody({ instruction: "fix", selectedText: "a", language: "js", path: "/a.js" })).toEqual({
      instruction: "fix",
      selectedText: "a",
      language: "js",
      path: "/a.js",
    })
  })

  test("returns undefined for a missing instruction or an empty selection", () => {
    expect(validateInlineEditBody({ instruction: "  ", selectedText: "a" })).toBeUndefined()
    expect(validateInlineEditBody({ instruction: "x", selectedText: "" })).toBeUndefined()
    expect(validateInlineEditBody(null)).toBeUndefined()
  })
})
