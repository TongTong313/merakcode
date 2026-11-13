import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { zh } from "./zh"

const src = path.resolve(import.meta.dirname, "..")
const dictionaries = new Set([path.join(src, "i18n", "zh.ts"), path.join(src, "i18n", "en.ts")])

/**
 * Keys the code builds from a template string such as t(`group.kind.${value}`): the source holds only the template,
 * so each one lists the template's start and the keys its variable can produce.
 */
const templated = [
  { template: "agents.step.${", keys: /^agents\.step\.(product|connection|duties|permissions)$/ },
  { template: "agents.env.${", keys: /^agents\.env\.(invalid|duplicate)$/ },
  { template: "group.kind.${", keys: /^group\.kind\.(local|cloud)$/ },
  { template: "group.initiative.${", keys: /^group\.initiative\.(passive|normal|eager)$/ },
  { template: "permission.option.${", keys: /^permission\.option\.(prefix|file|directory|domain|agent|tool)$/ },
  { template: "panel.${", keys: /^panel\.(review|plan|git|terminal|browser)$/ },
  {
    template: "git.${",
    keys: /^git\.(staged|unstaged|stage|unstage|stageAll|unstageAll|stageSelected|unstageSelected)$/,
  },
  { template: "git.blocked.${", keys: /^git\.blocked\.(not_git|unborn|managed_worktree|busy)$/ },
  { template: "git.role.${", keys: /^git\.role\.(switch|start)$/ },
  { template: "git.title.${", keys: /^git\.title\.(switch|start)$/ },
  { template: "review.scope.${", keys: /^review\.scope\.(turn|session)$/ },
  { template: "settings.about.manual.${", keys: /^settings\.about\.manual\.(mac-unsigned|linux-package)$/ },
  { template: "settings.about.unavailable.${", keys: /^settings\.about\.unavailable\.disabled$/ },
  {
    template: "task.status.${",
    keys: /^task\.status\.(draft|open|queued|running|review|blocked|done|failed|cancelled)$/,
  },
]

function sources() {
  return readdirSync(src, { recursive: true, encoding: "utf8" })
    .map((entry) => path.join(src, entry))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !dictionaries.has(file))
    .map((file) => readFileSync(file, "utf8"))
}

describe("dictionary usage", () => {
  const text = sources().join("\n")
  const keys = Object.keys(zh)
  const literal = (key: string) => [`"${key}"`, `'${key}'`, `\`${key}\``].some((quoted) => text.includes(quoted))

  test("every key of zh.ts is referenced at least once under src", () => {
    expect(text.length).toBeGreaterThan(100_000)
    const unused = keys.filter((key) => !literal(key) && !templated.some((item) => item.keys.test(key)))
    expect(unused).toEqual([])
  })

  test("every whitelisted template is in the code and matches keys of the dictionary", () => {
    const stale = templated.filter(
      (item) => !text.includes(`\`${item.template}`) || !keys.some((key) => item.keys.test(key)),
    )
    expect(stale.map((item) => item.template)).toEqual([])
  })
})
