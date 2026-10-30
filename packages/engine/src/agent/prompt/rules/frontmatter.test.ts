import { describe, expect, test } from "vitest"
import { RuleFrontmatter } from "./frontmatter"

function ok(data: unknown) {
  const result = RuleFrontmatter.parse(data)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason.zh)
  return result.value
}

function fail(data: unknown) {
  const result = RuleFrontmatter.parse(data)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("expected parse to fail")
  return result.reason
}

describe("RuleFrontmatter.parsePatterns", () => {
  // Cursor .mdc files use this form (e.g. .cursor/rules/packages-feature-unit-tests.mdc in this repo).
  // Accepting only arrays would silently disable imported cursor rules
  test("accepts the comma separated string form used by cursor", () => {
    expect(RuleFrontmatter.parsePatterns("packages/**/*.ts, packages/**/*.tsx")).toEqual([
      "packages/**/*.ts",
      "packages/**/*.tsx",
    ])
  })

  test("accepts the yaml array form", () => {
    expect(RuleFrontmatter.parsePatterns(["src/**/*.ts", "test/**/*.ts"])).toEqual(["src/**/*.ts", "test/**/*.ts"])
  })

  test("splits array entries that themselves contain commas", () => {
    expect(RuleFrontmatter.parsePatterns(["a/*.ts, b/*.ts", "c/*.ts"])).toEqual(["a/*.ts", "b/*.ts", "c/*.ts"])
  })

  // YAML block scalars fold multiple lines into one string
  test("treats newlines as separators", () => {
    expect(RuleFrontmatter.parsePatterns("src/**\nlib/**")).toEqual(["src/**", "lib/**"])
  })

  test("normalizes backslashes to forward slashes", () => {
    expect(RuleFrontmatter.parsePatterns("src\\**\\*.ts")).toEqual(["src/**/*.ts"])
  })

  test("strips surrounding quotes and blank entries", () => {
    expect(RuleFrontmatter.parsePatterns('"src/**/*.ts", , ')).toEqual(["src/**/*.ts"])
  })

  test("deduplicates", () => {
    expect(RuleFrontmatter.parsePatterns("a.ts, a.ts")).toEqual(["a.ts"])
  })

  test("returns empty for missing or unusable values", () => {
    expect(RuleFrontmatter.parsePatterns(undefined)).toEqual([])
    expect(RuleFrontmatter.parsePatterns(null)).toEqual([])
    expect(RuleFrontmatter.parsePatterns({})).toEqual([])
    expect(RuleFrontmatter.parsePatterns("")).toEqual([])
  })
})

describe("RuleFrontmatter.parseNames", () => {
  test("accepts string and array forms", () => {
    expect(RuleFrontmatter.parseNames("build, plan")).toEqual(["build", "plan"])
    expect(RuleFrontmatter.parseNames(["build", "plan"])).toEqual(["build", "plan"])
  })

  test("returns undefined when absent or empty", () => {
    expect(RuleFrontmatter.parseNames(undefined)).toBeUndefined()
    expect(RuleFrontmatter.parseNames("")).toBeUndefined()
    expect(RuleFrontmatter.parseNames([])).toBeUndefined()
    expect(RuleFrontmatter.parseNames(42)).toBeUndefined()
  })

  test("does not rewrite separators inside names", () => {
    expect(RuleFrontmatter.parseNames("a\\b")).toEqual(["a\\b"])
  })
})

describe("RuleFrontmatter.parseBool", () => {
  test("passes through real booleans", () => {
    expect(RuleFrontmatter.parseBool(true)).toBe(true)
    expect(RuleFrontmatter.parseBool(false)).toBe(false)
  })

  // ConfigMarkdown's lenient YAML fallback can leave values as strings
  test("accepts the string spellings true and false", () => {
    expect(RuleFrontmatter.parseBool("true")).toBe(true)
    expect(RuleFrontmatter.parseBool("TRUE")).toBe(true)
    expect(RuleFrontmatter.parseBool("  false  ")).toBe(false)
    expect(RuleFrontmatter.parseBool("False")).toBe(false)
  })

  test("returns undefined for absent or unrecognized values", () => {
    expect(RuleFrontmatter.parseBool(undefined)).toBeUndefined()
    expect(RuleFrontmatter.parseBool("maybe")).toBeUndefined()
    expect(RuleFrontmatter.parseBool("yes")).toBeUndefined()
    expect(RuleFrontmatter.parseBool("1")).toBeUndefined()
    expect(RuleFrontmatter.parseBool(1)).toBeUndefined()
    expect(RuleFrontmatter.parseBool({})).toBeUndefined()
  })
})

describe("RuleFrontmatter.hasFields", () => {
  test("is false for missing or empty frontmatter", () => {
    expect(RuleFrontmatter.hasFields(undefined)).toBe(false)
    expect(RuleFrontmatter.hasFields(null)).toBe(false)
    expect(RuleFrontmatter.hasFields("text")).toBe(false)
    expect(RuleFrontmatter.hasFields(42)).toBe(false)
    expect(RuleFrontmatter.hasFields([])).toBe(false)
    expect(RuleFrontmatter.hasFields({})).toBe(false)
  })

  test("is true when any key is present", () => {
    expect(RuleFrontmatter.hasFields({ name: "x" })).toBe(true)
    expect(RuleFrontmatter.hasFields({ alwaysApply: false })).toBe(true)
  })
})

describe("RuleFrontmatter.classify", () => {
  const base = { alwaysApply: false, globs: [] as string[], description: "" }

  test("alwaysApply wins over everything else", () => {
    const result = RuleFrontmatter.classify({ ...base, alwaysApply: true, globs: ["a"], description: "d" })
    expect(result.type).toBe("always")
  })

  test("globs make it auto attached", () => {
    expect(RuleFrontmatter.classify({ ...base, globs: ["src/**"] }).type).toBe("auto")
  })

  // Cursor uses globs when both globs and description are present
  test("globs take precedence over description", () => {
    expect(RuleFrontmatter.classify({ ...base, globs: ["src/**"], description: "d" }).type).toBe("auto")
  })

  test("description alone makes it agent requested", () => {
    expect(RuleFrontmatter.classify({ ...base, description: "d" }).type).toBe("agent-requested")
  })

  test("nothing declared makes it manual", () => {
    expect(RuleFrontmatter.classify(base).type).toBe("manual")
  })

  test("alwaysApply false does not by itself force a type", () => {
    expect(RuleFrontmatter.classify({ ...base, alwaysApply: false, description: "d" }).type).toBe("agent-requested")
  })
})

describe("RuleFrontmatter.parse", () => {
  test("reads the cursor mdc shape end to end", () => {
    const parsed = ok({
      description: "packages 下新增功能必须同步补充 bun 单测",
      globs: "packages/**/*.ts, packages/**/*.tsx",
      alwaysApply: false,
    })
    expect(parsed.type).toBe("auto")
    expect(parsed.globs).toEqual(["packages/**/*.ts", "packages/**/*.tsx"])
    expect(parsed.description).toBe("packages 下新增功能必须同步补充 bun 单测")
  })

  test("reads the native shape with exclude and agents", () => {
    const parsed = ok({
      name: "components",
      description: "组件规范",
      globs: ["src/components/**/*.tsx"],
      exclude: ["src/components/**/*.test.tsx"],
      agents: ["build", "plan"],
      alwaysApply: false,
    })
    expect(parsed.name).toBe("components")
    expect(parsed.globs).toEqual(["src/components/**/*.tsx"])
    expect(parsed.exclude).toEqual(["src/components/**/*.test.tsx"])
    expect(parsed.agents).toEqual(["build", "plan"])
  })

  test("loads alwaysApply false without globs or description as manual", () => {
    const parsed = ok({ alwaysApply: false })
    expect(parsed.type).toBe("manual")
    expect(parsed.globs).toEqual([])
  })

  test("rejects a missing or non-object frontmatter", () => {
    for (const data of [undefined, null, "text", 42, {}, []]) {
      expect(fail(data)).toBe(RuleFrontmatter.Reason.missingAlwaysApply)
    }
  })

  test("rejects a missing alwaysApply even when other whitelist fields are present", () => {
    expect(fail({ globs: "src/**", description: "d" })).toBe(RuleFrontmatter.Reason.missingAlwaysApply)
  })

  test("rejects aliases instead of reading them", () => {
    expect(fail({ always_apply: true, glob: "src/**", agent: "build" })).toBe(RuleFrontmatter.Reason.missingAlwaysApply)
  })

  test("treats an empty or illegal alwaysApply as the same invalid reason", () => {
    for (const value of [null, "", "yes", "1", 1, "maybe", []]) {
      expect(fail({ alwaysApply: value })).toBe(RuleFrontmatter.Reason.invalidAlwaysApply)
    }
  })

  test("accepts the string spellings of alwaysApply", () => {
    expect(ok({ alwaysApply: "true" }).type).toBe("always")
    expect(ok({ alwaysApply: "FALSE" }).type).toBe("manual")
  })

  test("ignores unknown fields", () => {
    const parsed = ok({ alwaysApply: true, foo: 1, always_apply: false })
    expect(parsed.type).toBe("always")
    expect(parsed.alwaysApply).toBe(true)
  })

  test("rejects a mistyped optional field and stops at the first one", () => {
    expect(fail({ alwaysApply: false, description: 1, globs: 2 })).toBe(RuleFrontmatter.Reason.descriptionType)
    expect(fail({ alwaysApply: false, globs: 1 })).toBe(RuleFrontmatter.Reason.globsType)
    expect(fail({ alwaysApply: false, name: 1 })).toBe(RuleFrontmatter.Reason.nameType)
    expect(fail({ alwaysApply: false, exclude: { a: 1 } })).toBe(RuleFrontmatter.Reason.excludeType)
    expect(fail({ alwaysApply: false, agents: [1] })).toBe(RuleFrontmatter.Reason.agentsType)
    expect(fail({ alwaysApply: false, globs: ["src/**", 1] })).toBe(RuleFrontmatter.Reason.globsType)
  })
})
