import { describe, expect, test } from "vitest"
import path from "path"
import { RuleMatch } from "./match"
import { Rule } from "./rule"

const ROOT = path.resolve(path.join("/", "repo"))

function rule(overrides: Partial<Rule.Info> = {}): Rule.Info {
  return {
    id: path.join(ROOT, ".merakcode", "rules", "r.mdc"),
    name: "r",
    description: "",
    type: "auto",
    source: "native",
    scope: "project",
    layer: Rule.LAYER.native,
    filepath: path.join(ROOT, ".merakcode", "rules", "r.mdc"),
    root: ROOT,
    globs: [],
    exclude: [],
    agents: undefined,
    content: "# r",
    bytes: 3,
    truncated: false,
    ...overrides,
  }
}

describe("RuleMatch.relativize", () => {
  // Glob only understands forward slashes, but path.relative returns backslashes on Windows.
  // Without normalizing, every multi-level glob would silently fail to match on Windows
  test("returns a posix relative path regardless of platform separators", () => {
    expect(RuleMatch.relativize(ROOT, path.join(ROOT, "src", "a.ts"))).toBe("src/a.ts")
  })

  test("returns undefined for targets outside the base", () => {
    expect(RuleMatch.relativize(path.join(ROOT, "src"), path.join(ROOT, "lib", "a.ts"))).toBeUndefined()
    expect(RuleMatch.relativize(path.join(ROOT, "src"), path.join(ROOT, "src"))).toBeUndefined()
  })

  test("does not treat a sibling with a shared prefix as inside", () => {
    expect(RuleMatch.relativize(path.join(ROOT, "src"), path.join(ROOT, "src-gen", "a.ts"))).toBeUndefined()
  })
})

describe("RuleMatch.matchesPatterns", () => {
  test("matches recursive globs", () => {
    expect(RuleMatch.matchesPatterns("src/a/b.ts", ["src/**/*.ts"])).toBe(true)
    expect(RuleMatch.matchesPatterns("lib/a.ts", ["src/**/*.ts"])).toBe(false)
  })

  test("matches brace expansion", () => {
    expect(RuleMatch.matchesPatterns("src/a.tsx", ["src/*.{ts,tsx}"])).toBe(true)
  })

  // Users expect `*.ts` to mean .ts files in any directory; a literal match would only hit files at the root
  test("a pattern without a slash also matches the basename at any depth", () => {
    expect(RuleMatch.matchesPatterns("a/b/c.ts", ["*.ts"])).toBe(true)
    expect(RuleMatch.matchesPatterns("a/b/AGENTS.md", ["AGENTS.md"])).toBe(true)
  })

  test("a pattern with a slash stays anchored to the base", () => {
    expect(RuleMatch.matchesPatterns("a/b/c.ts", ["b/*.ts"])).toBe(false)
  })

  test("a trailing slash means the whole subtree", () => {
    expect(RuleMatch.matchesPatterns("src/a/b.ts", ["src/"])).toBe(true)
    expect(RuleMatch.matchesPatterns("lib/a.ts", ["src/"])).toBe(false)
  })

  // One invalid glob must not break the whole rule system
  test("an invalid pattern is treated as no match instead of throwing", () => {
    expect(() => RuleMatch.matchesPatterns("a.ts", ["["])).not.toThrow()
    expect(RuleMatch.matchesPatterns("a.ts", ["[", "*.ts"])).toBe(true)
  })

  test("empty pattern list never matches", () => {
    expect(RuleMatch.matchesPatterns("a.ts", [])).toBe(false)
  })
})

describe("RuleMatch.matchesFile", () => {
  test("matches relative to the rule root, not the process cwd", () => {
    const r = rule({ globs: ["src/**/*.ts"] })
    expect(RuleMatch.matchesFile(r, path.join(ROOT, "src", "a.ts"))).toBe(true)
    expect(RuleMatch.matchesFile(r, path.join(ROOT, "other", "a.ts"))).toBe(false)
  })

  // Globs resolve against the rule's own root: with a subdirectory opened as the folder, src/** written there
  // matches src/** under that root, not under the ancestor repository root
  test("a rule resolves globs against its own root", () => {
    const pkg = path.join(ROOT, "packages", "foo")
    const r = rule({ root: pkg, globs: ["src/**/*.ts"] })
    expect(RuleMatch.matchesFile(r, path.join(pkg, "src", "a.ts"))).toBe(true)
    expect(RuleMatch.matchesFile(r, path.join(ROOT, "src", "a.ts"))).toBe(false)
  })

  test("exclude wins over globs", () => {
    const r = rule({ globs: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] })
    expect(RuleMatch.matchesFile(r, path.join(ROOT, "src", "a.ts"))).toBe(true)
    expect(RuleMatch.matchesFile(r, path.join(ROOT, "src", "a.test.ts"))).toBe(false)
  })

  test("never matches when there are no globs", () => {
    expect(RuleMatch.matchesFile(rule({ globs: [] }), path.join(ROOT, "src", "a.ts"))).toBe(false)
  })

  test("a recursive glob covers everything under the root", () => {
    const pkg = path.join(ROOT, "packages", "foo")
    const r = rule({ root: pkg, globs: ["**/*"] })
    expect(RuleMatch.matchesFile(r, path.join(pkg, "deep", "nested", "a.ts"))).toBe(true)
    expect(RuleMatch.matchesFile(r, path.join(ROOT, "packages", "bar", "a.ts"))).toBe(false)
  })
})

describe("RuleMatch.allowsAgent", () => {
  test("a rule without agents is open to all", () => {
    expect(RuleMatch.allowsAgent(rule(), "build")).toBe(true)
    expect(RuleMatch.allowsAgent(rule({ agents: [] }), "build")).toBe(true)
  })

  test("a rule with agents only applies to those agents", () => {
    const r = rule({ agents: ["plan"] })
    expect(RuleMatch.allowsAgent(r, "plan")).toBe(true)
    expect(RuleMatch.allowsAgent(r, "build")).toBe(false)
  })

  // Callers without agent information must not have every rule filtered out
  test("an unknown agent does not filter the rule out", () => {
    expect(RuleMatch.allowsAgent(rule({ agents: ["plan"] }), undefined)).toBe(true)
  })
})

describe("RuleMatch.forFile", () => {
  test("keeps only auto rules that match, ordered general to specific", () => {
    const pkg = path.join(ROOT, "packages", "foo")
    const external = rule({
      name: "external",
      source: "external",
      layer: Rule.LAYER.external,
      globs: ["**/*.ts"],
    })
    const shallow = rule({ name: "shallow", globs: ["**/*.ts"] })
    const deep = rule({ name: "deep", root: pkg, globs: ["**/*.ts"] })
    const always = rule({ name: "always", type: "always" })
    const manual = rule({ name: "manual", type: "manual" })
    const missed = rule({ name: "missed", globs: ["*.py"] })

    const result = RuleMatch.forFile([deep, always, manual, missed, shallow, external], path.join(pkg, "src", "a.ts"))
    expect(result.map((r) => r.name)).toEqual(["external", "shallow", "deep"])
  })

  test("applies the agent gate", () => {
    const open = rule({ name: "open", globs: ["**/*.ts"] })
    const gated = rule({ name: "gated", globs: ["**/*.ts"], agents: ["plan"] })
    const result = RuleMatch.forFile([open, gated], path.join(ROOT, "a.ts"), { agent: "build" })
    expect(result.map((r) => r.name)).toEqual(["open"])
  })
})

describe("RuleMatch.byFilepath", () => {
  test("hits any type by resolved path", () => {
    const target = path.join(ROOT, ".merakcode", "rules", "rpc.mdc")
    const hit = rule({ name: "rpc", type: "agent-requested", filepath: target })
    const other = rule({ name: "other", type: "manual", filepath: path.join(ROOT, ".merakcode", "rules", "other.mdc") })
    expect(RuleMatch.byFilepath([hit, other], target)?.name).toBe("rpc")
  })

  // file:// mentions from clients often have a lowercase drive letter, while scanned rule paths are often uppercase.
  // Comparing path.resolve results directly would treat the .mdc as a plain file and dump its YAML.
  test("hits a rule when the mention only differs by drive-letter case", () => {
    const target = path.join(ROOT, ".merakcode", "rules", "rpc.mdc")
    const hit = rule({ name: "rpc", type: "agent-requested", filepath: target })
    const flipped = target.replace(
      /^([A-Za-z]):/,
      (_, drive: string) => `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}:`,
    )
    expect(RuleMatch.byFilepath([hit], flipped)?.name).toBe("rpc")
  })
})

describe("RuleMatch.forMention", () => {
  test("keeps only the manual rule whose filepath is the mentioned file", () => {
    const target = path.join(ROOT, ".merakcode", "rules", "review.mdc")
    const hit = rule({ name: "review", type: "manual", filepath: target, agents: ["plan"] })
    const other = rule({
      name: "other",
      type: "manual",
      filepath: path.join(ROOT, ".merakcode", "rules", "other.mdc"),
    })
    const auto = rule({ name: "auto", type: "auto", globs: ["**/*.mdc"] })
    const always = rule({ name: "always", type: "always", filepath: target })

    const result = RuleMatch.forMention([hit, other, auto, always], target)
    expect(result.map((r) => r.name)).toEqual(["review"])
  })

  test("does not apply the agents gate", () => {
    const target = path.join(ROOT, ".merakcode", "rules", "gated.mdc")
    const gated = rule({ name: "gated", type: "manual", filepath: target, agents: ["plan"] })
    expect(RuleMatch.forMention([gated], target).map((r) => r.name)).toEqual(["gated"])
  })

  test("returns empty when the mentioned file is not a manual rule", () => {
    const target = path.join(ROOT, "src", "a.ts")
    const manual = rule({ name: "manual", type: "manual" })
    expect(RuleMatch.forMention([manual], target)).toEqual([])
  })
})
