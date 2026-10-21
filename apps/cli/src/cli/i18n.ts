import { peekGlobalConfig } from "@merakcode/util/config-peek"
import zhCN from "./locales/zh-CN.json"
import enUS from "./locales/en-US.json"

/**
 * Text of the merak commands: one Chinese/English dictionary (src/cli/locales). Commands need it before config is
 * loaded, so the language is resolved synchronously: MERAKCODE_LOCALE → global config locale → Chinese.
 */
export namespace I18n {
  export type Locale = "zh-CN" | "en-US"
  const dictionaries: Record<Locale, Record<string, string>> = { "zh-CN": zhCN, "en-US": enUS }

  export function format(locale: Locale, key: string, params?: Record<string, unknown>) {
    const text = dictionaries[locale][key] ?? dictionaries["zh-CN"][key] ?? key
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }

  function normalize(value?: string): Locale | undefined {
    const lower = value?.toLowerCase()
    if (lower?.startsWith("zh")) return "zh-CN"
    if (lower?.startsWith("en")) return "en-US"
  }

  export function resolve(input: { env?: string; config?: string }): Locale {
    const fromEnv = normalize(input.env)
    if (fromEnv) return fromEnv
    return input.config === "en-US" || input.config === "zh-CN" ? input.config : "zh-CN"
  }

  let cached: Locale | undefined
  export function current(): Locale {
    if (cached) return cached
    cached = resolve({ env: process.env.MERAKCODE_LOCALE, config: peekGlobalConfig().locale })
    return cached
  }

  export function t(key: string, params?: Record<string, unknown>) {
    return format(current(), key, params)
  }
}
