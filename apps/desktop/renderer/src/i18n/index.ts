import { createSignal } from "solid-js"
import { en } from "./en"
import { zh } from "./zh"

export type Locale = "zh" | "en"
export type Key = keyof typeof zh

const dicts: Record<Locale, Record<Key, string>> = { zh, en }

/** 系统语言是中文就用中文，否则英文 */
export function detect(languages: readonly string[] = navigator.languages ?? [navigator.language]): Locale {
  return languages.some((language) => language?.toLowerCase().startsWith("zh")) ? "zh" : "en"
}

/** 全局配置里的 locale（zh-CN / en-US） */
export const fromConfig = (value?: string): Locale | undefined =>
  value === "zh-CN" ? "zh" : value === "en-US" ? "en" : undefined
export const toConfig = (locale: Locale) => (locale === "zh" ? "zh-CN" : "en-US")

const [locale, set] = createSignal<Locale>(detect())
export { locale }

export function setLocale(next: Locale) {
  set(next)
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en"
}

/** 取当前语言的文字，{name} 换成 vars 里的值 */
export function t(key: Key, vars?: Record<string, string | number>) {
  const text = dicts[locale()][key]
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

/** 带数字的相对时间：刚刚、5 分钟前、昨天… */
export function ago(time: number, now = Date.now()) {
  const seconds = Math.round((time - now) / 1000)
  if (Math.abs(seconds) < 45) return t("time.now")
  const format = new Intl.RelativeTimeFormat(locale() === "zh" ? "zh-CN" : "en", { numeric: "auto", style: "short" })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
  ]
  for (const [unit, size] of units.toReversed())
    if (Math.abs(seconds) >= size) {
      if (unit === "day" && Math.abs(seconds) >= 7 * 86400)
        return new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric" }).format(
          time,
        )
      return format.format(Math.round(seconds / size), unit)
    }
  return format.format(Math.round(seconds / 60), "minute")
}
