import { describe, expect, test } from "vitest"
import { RuleFrontmatter } from "./frontmatter"
import { RuleTemplate } from "./template"
import matter from "gray-matter"

/** Generated text must read back unchanged, so tests always parse it with gray-matter + RuleFrontmatter.parse */
function roundtrip(source: string) {
  const md = matter(source)
  const parsed = RuleFrontmatter.parse(md.data)
  if (!parsed.ok) throw new Error(`frontmatter should parse, but failed: ${parsed.reason}`)
  return { fields: parsed.value, body: md.content.trim() }
}

describe("RuleTemplate.isRuleFile", () => {
  test("matches .mdc under .merakcode/rules and .cursor/rules (subdirectories, singular/plural, backslashes)", () => {
    for (const path of [
      "/w/.merakcode/rules/a.mdc",
      "/w/.merakcode/rule/a.mdc",
      "/w/.merakcode/rules/frontend/nested/a.mdc",
      "/w/.cursor/rules/a.mdc",
      "C:\\w\\.cursor\\rules\\a.MDC",
      "/w/packages/foo/.merakcode/rules/a.mdc",
    ]) {
      expect(RuleTemplate.isRuleFile(path), path).toBe(true)
    }
  })

  test("does not match .mdc outside rule directories or non-.mdc files inside them", () => {
    for (const path of [
      "/w/docs/a.mdc",
      "/w/.merakcode/a.mdc",
      "/w/.cursor/a.mdc",
      "/w/.merakcode/rules/a.md",
      "/w/.merakcode/rules/README.txt",
      "/w/AGENTS.md",
      "a.mdc",
    ]) {
      expect(RuleTemplate.isRuleFile(path), path).toBe(false)
    }
  })
})

describe("RuleTemplate.fresh", () => {
  test("a new .mdc has a valid alwaysApply: true and a non-empty body", () => {
    const { fields, body } = roundtrip(RuleTemplate.fresh())
    expect(fields.alwaysApply).toBe(true)
    expect(fields.type).toBe("always")
    // Rule.load records an .mdc with an empty body as a load failure, so the template needs placeholder text
    expect(body).toBe(RuleTemplate.PLACEHOLDER_BODY.zh)
    expect(body.length).toBeGreaterThan(0)
  })

  test("uses the English placeholder body for the English UI", () => {
    const { fields, body } = roundtrip(RuleTemplate.fresh("en"))
    expect(fields.alwaysApply).toBe(true)
    expect(body).toBe(RuleTemplate.PLACEHOLDER_BODY.en)
  })
})

describe("RuleTemplate.build", () => {
  test("written fields classify the same way as the frontend preview", () => {
    const { fields } = roundtrip(
      RuleTemplate.build({ alwaysApply: false, globs: ["**/*.ts"], description: "d", body: "x" }),
    )
    expect(fields.type).toBe("auto")
    expect(fields.globs).toEqual(["**/*.ts"])
    expect(fields.description).toBe("d")
  })

  test("omits empty fields instead of writing noise like globs: []", () => {
    const source = RuleTemplate.build({ alwaysApply: true, globs: [], exclude: ["  "], name: " ", body: "x" })
    expect(source).not.toContain("globs")
    expect(source).not.toContain("exclude")
    expect(source).not.toContain("name")
  })

  test("pattern lists drop blanks and duplicates and keep order", () => {
    const { fields } = roundtrip(RuleTemplate.build({ alwaysApply: false, globs: [" b ", "a", "b", "  "], body: "x" }))
    expect(fields.globs).toEqual(["b", "a"])
  })

  test("an empty body falls back to the placeholder so the rule does not fail to load", () => {
    const { body } = roundtrip(RuleTemplate.build({ alwaysApply: true, body: "   \n  " }))
    expect(body).toBe(RuleTemplate.PLACEHOLDER_BODY.zh)
  })

  test("writes alwaysApply: false explicitly (only a missing field fails to load)", () => {
    const { fields } = roundtrip(RuleTemplate.build({ alwaysApply: false, body: "x" }))
    expect(fields.alwaysApply).toBe(false)
    expect(fields.type).toBe("manual")
  })
})
