/**
 * Types and parameter filling for Chinese/English text pairs (pure functions). Picking the language from config
 * lives in the engine's util/text.ts.
 */
export namespace Text {
  export type Lang = "zh" | "en"
  export type Pair = { zh: string; en: string }

  export function format(text: Pair, lang: Lang, params?: Record<string, unknown>) {
    const value = text[lang]
    if (!params) return value
    return value.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}
