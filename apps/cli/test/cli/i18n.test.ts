import { describe, expect, test } from "vitest"
import fs from "fs"
import path from "path"
import zhCN from "../../src/cli/locales/zh-CN.json"
import enUS from "../../src/cli/locales/en-US.json"
import { I18n } from "../../src/cli/i18n"

// The TUI and the merak subcommands share one Chinese/English dictionary: both sides have the same keys, every entry
// has text, and every key hard-coded in the source exists

const zh = zhCN as Record<string, string>
const en = enUS as Record<string, string>

describe("dictionary", () => {
  test("Chinese and English have exactly the same keys", () => {
    expect(Object.keys(zh).filter((key) => !(key in en))).toEqual([])
    expect(Object.keys(en).filter((key) => !(key in zh))).toEqual([])
  })

  test("every entry has text", () => {
    for (const dict of [zh, en]) expect(Object.entries(dict).filter(([, value]) => !value.trim())).toEqual([])
  })

  test('every key used in the source (literal t("…") / locale.t("…")) is in the dictionary', () => {
    const root = path.join(import.meta.dirname, "../../src")
    const files = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    const used = new Set<string>()
    for (const entry of files) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")
      for (const match of text.matchAll(/\b(?:locale\.t|I18n\.t|t)\(\s*"([a-zA-Z][\w.-]*)"/g)) used.add(match[1]!)
    }
    expect([...used].filter((key) => !(key in zh))).toEqual([])
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
    expect(I18n.format("zh-CN", "permission.model", { model: "qwen" })).toBe("模型 qwen")
    expect(I18n.format("en-US", "permission.model", { model: "qwen" })).toBe("model qwen")
    expect(I18n.format("en-US", "permission.model")).toBe("model {model}")
  })
})

test("I18n.t follows a locale switch (the TUI calls I18n.use when switching at runtime)", () => {
  const before = I18n.current()
  try {
    I18n.use("en-US")
    expect(I18n.t("permission.model", { model: "x" })).toBe("model x")
    I18n.use("zh-CN")
    expect(I18n.t("permission.model", { model: "x" })).toBe("模型 x")
  } finally {
    I18n.use(before)
  }
})
