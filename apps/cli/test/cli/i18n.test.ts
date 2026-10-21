import { describe, expect, test } from "vitest"
import fs from "fs"
import path from "path"
import zhCN from "../../src/cli/locales/zh-CN.json"
import enUS from "../../src/cli/locales/en-US.json"
import { I18n } from "../../src/cli/i18n"

// The merak commands' Chinese/English dictionary: both sides have the same keys, every entry has text, every key
// hard-coded in the source exists, and every key in the dictionary is used

const zh = zhCN as Record<string, string>
const en = enUS as Record<string, string>

/** Keys the source builds at runtime from a prefix, so they never appear as a whole string */
const DYNAMIC = ["cli.yargs.", "cli.sandbox.limit.", "cli.doctor.check."]

function sources() {
  const root = path.join(import.meta.dirname, "../../src")
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
}

describe("dictionary", () => {
  test("Chinese and English have exactly the same keys", () => {
    expect(Object.keys(zh).filter((key) => !(key in en))).toEqual([])
    expect(Object.keys(en).filter((key) => !(key in zh))).toEqual([])
  })

  test("every entry has text", () => {
    for (const dict of [zh, en]) expect(Object.entries(dict).filter(([, value]) => !value.trim())).toEqual([])
  })

  test('every key used in the source (literal t("…") / I18n.t("…")) is in the dictionary', () => {
    const used = new Set<string>()
    for (const text of sources())
      for (const match of text.matchAll(/\b(?:I18n\.t|t)\(\s*"([a-zA-Z][\w.-]*)"/g)) used.add(match[1]!)
    expect([...used].filter((key) => !(key in zh))).toEqual([])
  })

  test("every key in the dictionary is used by the source", () => {
    const text = sources().join("\n")
    const unused = Object.keys(zh).filter(
      (key) => !DYNAMIC.some((prefix) => key.startsWith(prefix)) && !text.includes(`"${key}"`),
    )
    expect(unused).toEqual([])
  })
})

describe("locale", () => {
  test("MERAKCODE_LOCALE wins, then the locale in the global config, otherwise Chinese", () => {
    expect(I18n.resolve({ env: "en_US.UTF-8", config: "zh-CN" })).toBe("en-US")
    expect(I18n.resolve({ config: "en-US" })).toBe("en-US")
    expect(I18n.resolve({ config: "fr-FR" })).toBe("zh-CN")
    expect(I18n.resolve({})).toBe("zh-CN")
  })

  test("formats an entry for the locale with its parameters, keeping placeholders whose parameter is missing", () => {
    expect(I18n.format("zh-CN", "cli.unexpected", { file: "a.log", run: "r1" })).toContain(
      "日志里：a.log（运行编号 r1）",
    )
    expect(I18n.format("en-US", "cli.unexpected", { file: "a.log", run: "r1" })).toContain("in the log: a.log (run r1)")
    expect(I18n.format("en-US", "cli.unexpected", { file: "a.log" })).toContain("a.log (run {run})")
  })
})
