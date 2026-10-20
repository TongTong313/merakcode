import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { Bus } from "@merakcode/engine/bus/index"
import { Rule } from "@merakcode/engine/rule/rule"
import { RuleFrontmatter } from "@merakcode/engine/rule/frontmatter"
import { RuleMatch } from "@merakcode/engine/rule/match"
import { Config } from "@merakcode/engine/config/config"
import { Instance } from "@merakcode/engine/project/instance"
import { Session } from "@merakcode/engine/session/index"
import { tmpdir } from "../fixture/fixture"
import { cursorRule, isolate, nativeRule, ruleFlags } from "./isolate"
import { Filesystem } from "@merakcode/util/filesystem"

const flag = ruleFlags()

describe("Rule.state discovery", () => {
  test("loads native project rules and derives names from the relative path", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "style.mdc", "alwaysApply: true")
          await nativeRule(dir, path.join("frontend", "components.mdc"), "alwaysApply: false\nglobs: src/**/*.tsx")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const rules = await Rule.all()
          expect(rules.map((r) => r.name).sort()).toEqual(["frontend/components", "style"])
          const style = rules.find((r) => r.name === "style")!
          expect(style.type).toBe("always")
          expect(style.source).toBe("native")
          expect(style.scope).toBe("project")
          expect(style.layer).toBe(Rule.LAYER.native)
          expect(style.root).toBe(tmp.path)
          expect(style.content).toBe("# body")
        },
      })
    })
  })

  test("frontmatter name overrides the path derived name", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "whatever.mdc", "name: explicit\nalwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["explicit"])
        },
      })
    })
  })

  test("accepts the rules and rule directory spellings", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Filesystem.write(path.join(dir, ".merakcode", "rule", "a.mdc"), "---\nalwaysApply: true\n---\n\nA\n")
          await Filesystem.write(path.join(dir, ".merakcode", "rules", "b.mdc"), "---\nalwaysApply: true\n---\n\nB\n")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name).sort()).toEqual(["a", "b"])
        },
      })
    })
  })

  test("does not load .mdc files from the global config rules directory", async () => {
    await isolate(async (globalDir) => {
      await Filesystem.write(path.join(globalDir, "rules", "global.mdc"), "---\nalwaysApply: true\n---\n\nGlobal\n")
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
        },
      })
    })
  })

  test("orders rules general to specific by layer", async () => {
    await isolate(async (globalDir) => {
      await Filesystem.write(path.join(globalDir, "merakcode.json"), JSON.stringify({ rules: { user: ["G"] } }))
      Config.global.reset()
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "n.mdc", "alwaysApply: true")
          await cursorRule(path.join(dir, "sub"), "e.mdc", "alwaysApply: true")
        },
      })
      await Instance.provide({
        directory: path.join(tmp.path, "sub"),
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["user-rule-1", "e", "n"])
        },
      })
    })
  })

  test("returns nothing when rules are disabled", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "a.mdc", "alwaysApply: true"),
      })
      flag.MERAKCODE_DISABLE_RULES = true
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
        },
      })
    })
  })
})

describe("Rule.state cursor compatibility", () => {
  test("reads .cursor/rules with the comma separated globs form", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) =>
          cursorRule(
            dir,
            "tests.mdc",
            "description: packages 下新增功能必须补单测\nglobs: packages/**/*.ts, packages/**/*.tsx\nalwaysApply: false",
          ),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const rules = await Rule.all()
          expect(rules.length).toBe(1)
          expect(rules[0].source).toBe("external")
          expect(rules[0].layer).toBe(Rule.LAYER.external)
          expect(rules[0].type).toBe("auto")
          expect(rules[0].globs).toEqual(["packages/**/*.ts", "packages/**/*.tsx"])
        },
      })
    })
  })

  // When a user with .cursor/rules adds native rules, the cursor rules in that directory yield entirely.
  test("native rules shadow .cursor/rules in the same directory", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "native.mdc", "alwaysApply: true")
          await cursorRule(dir, "external.mdc", "alwaysApply: true")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["native"])
          const shadowed = await Rule.shadowed()
          expect(shadowed.length).toBe(1)
          expect(shadowed[0].directory).toBe(path.join(tmp.path, ".cursor", "rules"))
          expect(shadowed[0].by).toBe(1)
        },
      })
    })
  })

  test("empty .cursor/rules directory is not shadowed", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "native.mdc", "alwaysApply: true")
          await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true })
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["native"])
          expect(await Rule.shadowed()).toEqual([])
        },
      })
    })
  })

  test("unreadable .mdc in .cursor/rules still counts as shadowed", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "native.mdc", "alwaysApply: true")
          await Filesystem.write(path.join(dir, ".cursor", "rules", "broken.mdc"), "not a rule\n")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const shadowed = await Rule.shadowed()
          expect(shadowed.length).toBe(1)
          expect(shadowed[0].directory).toBe(path.join(tmp.path, ".cursor", "rules"))
        },
      })
    })
  })

  // Native rules at the root must not hide cursor rules in ancestor or child folders.
  test("shadowing is per directory, not repository wide", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "native.mdc", "alwaysApply: true")
          await cursorRule(path.join(dir, "sub"), "external.mdc", "alwaysApply: true")
        },
      })
      await Instance.provide({
        directory: path.join(tmp.path, "sub"),
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name).sort()).toEqual(["external", "native"])
          expect(await Rule.shadowed()).toEqual([])
        },
      })
    })
  })

  test("skips .cursor/rules when cursor compatibility is disabled", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => cursorRule(dir, "external.mdc", "alwaysApply: true"),
      })
      flag.MERAKCODE_DISABLE_CURSOR_RULES = true
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
        },
      })
    })
  })
})

describe("Rule watch roots", () => {
  test("projectWatchRoots only enumerates upward from the opened folder", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "root.mdc", "alwaysApply: true")
          await nativeRule(path.join(dir, "packages", "foo"), "nested.mdc", "alwaysApply: false\nglobs: src/**")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const roots = Rule.projectWatchRoots()
          expect(roots).toContain(path.join(tmp.path, ".merakcode", "rules"))
          expect(roots).toContain(path.join(tmp.path, ".cursor", "rules"))
          expect(roots).not.toContain(path.join(tmp.path, "packages", "foo", ".merakcode", "rules"))
        },
      })
    })
  })
})

describe("Rule.state discovery scope", () => {
  test("does not load rules below the opened folder", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) =>
          nativeRule(path.join(dir, "packages", "foo"), "nested.mdc", "alwaysApply: false\nglobs: src/**/*.ts"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          expect(await RuleMatch.resolve(path.join(tmp.path, "packages", "foo", "src", "a.ts"))).toEqual([])
        },
      })
    })
  })

  test("still loads ancestor rules when the workspace is a subdirectory", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "root.mdc", "alwaysApply: false\nglobs: packages/foo/**/*.ts"),
      })
      await Instance.provide({
        directory: path.join(tmp.path, "packages", "foo"),
        fn: async () => {
          const rules = await Rule.all()
          expect(rules.map((r) => r.name)).toEqual(["root"])
          expect(rules[0].root).toBe(tmp.path)
          const matched = await RuleMatch.resolve(path.join(tmp.path, "packages", "foo", "src", "a.ts"))
          expect(matched.map((r) => r.name)).toEqual(["root"])
        },
      })
    })
  })

  // alwaysApply: false without globs or description is still a rule; at the root it stays manual.
  test("a rule at the folder root without conditions stays manual", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "root.mdc", "alwaysApply: false\nname: root"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const rules = await Rule.all()
          expect(rules.map((r) => r.type)).toEqual(["manual"])
          expect(await RuleMatch.resolve(path.join(tmp.path, "a.ts"))).toEqual([])
        },
      })
    })
  })
})

describe("Rule.state file recognition", () => {
  test("ignores .md files even when they have frontmatter", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Filesystem.write(
            path.join(dir, ".merakcode", "rules", "readme.md"),
            "---\nalwaysApply: true\n---\n\nSHOULD-NOT-LOAD\n",
          )
          await nativeRule(dir, "real.mdc", "alwaysApply: true", "REAL")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["real"])
          expect(await Rule.errors()).toEqual([])
        },
      })
    })
  })

  test("records an .mdc with no frontmatter as missing alwaysApply", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => Filesystem.write(path.join(dir, ".merakcode", "rules", "plain.mdc"), "# 纯正文规则\n"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          const errors = await Rule.errors()
          expect(errors.length).toBe(1)
          expect(errors[0].filepath).toBe(path.join(tmp.path, ".merakcode", "rules", "plain.mdc"))
          expect(errors[0].reason).toBe(RuleFrontmatter.Reason.missingAlwaysApply.zh)
        },
      })
    })
  })

  test("records empty or comment-only frontmatter as missing alwaysApply", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Filesystem.write(path.join(dir, ".merakcode", "rules", "empty.mdc"), "---\n---\n\nEMPTY\n")
          await Filesystem.write(
            path.join(dir, ".merakcode", "rules", "comment-only.mdc"),
            "---\n# note\n---\n\nCOMMENT\n",
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          const reasons = (await Rule.errors()).map((item) => item.reason)
          expect(reasons).toEqual([
            RuleFrontmatter.Reason.missingAlwaysApply.zh,
            RuleFrontmatter.Reason.missingAlwaysApply.zh,
          ])
        },
      })
    })
  })

  test("records a rule that omits alwaysApply", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "auto.mdc", "globs: src/**"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          expect((await Rule.errors())[0].reason).toBe(RuleFrontmatter.Reason.missingAlwaysApply.zh)
        },
      })
    })
  })

  test("records an illegal alwaysApply value", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "bad.mdc", "alwaysApply: maybe"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          expect((await Rule.errors())[0].reason).toBe(RuleFrontmatter.Reason.invalidAlwaysApply.zh)
        },
      })
    })
  })

  test("loads a rule while ignoring unknown frontmatter fields", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "extra.mdc", "alwaysApply: true\nfoo: 1\nalways_apply: false"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["extra"])
          expect(await Rule.errors()).toEqual([])
        },
      })
    })
  })

  test("records a mistyped optional field and does not load the rule", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "typed.mdc", "alwaysApply: false\ndescription: 1"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          expect((await Rule.errors())[0].reason).toBe(RuleFrontmatter.Reason.descriptionType.zh)
        },
      })
    })
  })
})

describe("Rule.state resilience", () => {
  /**
   * gray-matter caches a half-built object before throwing, so ConfigMarkdown's fallback retry hits the cache and
   * malformed frontmatter neither errors nor applies: every condition is lost and the rule silently becomes manual.
   * This silent failure must be reported as a load error.
   */
  test("records a rule whose frontmatter fails to parse instead of silently dropping its conditions", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Filesystem.write(path.join(dir, ".merakcode", "rules", "ok.mdc"), "---\nalwaysApply: true\n---\n\nOK\n")
          await Filesystem.write(
            path.join(dir, ".merakcode", "rules", "broken.mdc"),
            "---\nglobs: [unclosed\n  - ?bad\n---\n\nBroken\n",
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["ok"])
          const errors = await Rule.errors()
          expect(errors.length).toBe(1)
          expect(errors[0].filepath).toBe(path.join(tmp.path, ".merakcode", "rules", "broken.mdc"))
          expect(errors[0].reason).toContain("frontmatter")
        },
      })
    })
  })

  // A rule with frontmatter but no body would inject nothing useful.
  test("skips a rule with an empty body and records why", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "hollow.mdc", "alwaysApply: true", ""),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
          expect((await Rule.errors())[0].reason).toBe("规则正文为空")
        },
      })
    })
  })

  test("truncates a rule that exceeds the per rule byte cap", async () => {
    await isolate(async () => {
      const body = "x".repeat(Rule.MAX_BYTES + 1000)
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "huge.mdc", "alwaysApply: true", body),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const rule = (await Rule.all())[0]
          expect(rule.truncated).toBe(true)
          expect(rule.content.length).toBeLessThan(body.length)
          expect(rule.content).toContain("[Rule content truncated")
        },
      })
    })
  })
})

describe("Rule user config rules", () => {
  test("reads rules.user from the global config", async () => {
    await isolate(async (globalDir) => {
      await Filesystem.write(
        path.join(globalDir, "merakcode.json"),
        JSON.stringify({ rules: { user: ["总是用中文回答", "  "] } }),
      )
      Config.global.reset()
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const rules = await Rule.all()
          expect(rules.length).toBe(1)
          expect(rules[0].source).toBe("user-config")
          expect(rules[0].type).toBe("always")
          expect(rules[0].content).toBe("总是用中文回答")
        },
      })
    })
  })

  // Global cross-project rules defined in a project config would contradict themselves.
  test("ignores rules.user coming from project config", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        config: { rules: { user: ["项目里偷偷加的全局规则"] } },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.all()).toEqual([])
        },
      })
    })
  })
})

describe("Rule.invalidate", () => {
  test("drops cached rules so the next scan sees disk deletes", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "gone.mdc", "alwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).map((r) => r.name)).toEqual(["gone"])
          const { unlink } = await import("fs/promises")
          await unlink(path.join(tmp.path, ".merakcode", "rules", "gone.mdc"))
          expect((await Rule.all()).map((r) => r.name)).toEqual(["gone"])
          Rule.invalidate()
          expect(await Rule.all()).toEqual([])
        },
      })
    })
  })
})

describe("Rule parse errors", () => {
  test("publishes a session.error with kind rule when frontmatter is illegal", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Filesystem.write(
            path.join(dir, ".merakcode", "rules", "broken.mdc"),
            "---\nglobs: [unclosed\n  - ?bad\n---\n\nBroken\n",
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const seen: Array<{ name?: string; data?: { kind?: string; path?: string } }> = []
          const off = Bus.subscribe(Session.Event.Error, (event) => {
            seen.push(event.properties.error as { name?: string; data?: { kind?: string; path?: string } })
          })
          await Rule.all()
          off()
          const hit = seen.find((error) => error.name === "ConfigParseError" && error.data?.kind === "rule")
          expect(hit).toBeDefined()
          expect(hit?.data?.path).toBe(path.join(tmp.path, ".merakcode", "rules", "broken.mdc"))
        },
      })
    })
  })
})

describe("Rule.byType and Rule.get", () => {
  test("filters by type and finds by name", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "a.mdc", "alwaysApply: true")
          await nativeRule(dir, "b.mdc", "alwaysApply: false\nglobs: src/**")
          await nativeRule(dir, "c.mdc", "alwaysApply: false\ndescription: 按需加载")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.byType("always")).map((r) => r.name)).toEqual(["a"])
          expect((await Rule.byType("auto")).map((r) => r.name)).toEqual(["b"])
          expect((await Rule.byType("agent-requested")).map((r) => r.name)).toEqual(["c"])
          expect((await Rule.get("b"))?.globs).toEqual(["src/**"])
          expect(await Rule.get("missing")).toBeUndefined()
        },
      })
    })
  })
})
