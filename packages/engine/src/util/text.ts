/**
 * Text the engine sends to the UI (tool card titles, reports, hints, user-visible errors): Chinese and English are
 * written side by side where used and picked by the configured locale (Chinese by default). Prompts and tool
 * descriptions for the model are English only and do not go through this.
 */
import { Text as Pure } from "@merakcode/util/text"

export namespace Text {
  export type Lang = Pure.Lang
  export type Pair = Pure.Pair
  export const format = Pure.format

  /**
   * Current language: MERAKCODE_LOCALE wins (matching the CLI's I18n); inside a project the merged config decides,
   * outside one (CLI subcommands, startup) the global config; otherwise Chinese. The dynamic import breaks a cycle:
   * config depends on many modules, so util cannot import it statically.
   */
  export async function lang(): Promise<Lang> {
    const env = process.env.MERAKCODE_LOCALE?.toLowerCase()
    if (env?.startsWith("en")) return "en"
    if (env?.startsWith("zh")) return "zh"
    const [{ Config }, { Instance }] = await Promise.all([import("../config/config"), import("../project/instance")])
    const config = await (Instance.has() ? Config.get() : Config.getGlobal()).catch(() => undefined)
    return config?.locale === "en-US" ? "en" : "zh"
  }

  export async function pick(text: Pair, params?: Record<string, unknown>) {
    return format(text, await lang(), params)
  }
}
