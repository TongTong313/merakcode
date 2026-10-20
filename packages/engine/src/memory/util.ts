import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import type { Message } from "../session/message"

/**
 * Helpers shared by MemoryExtract, MemoryPrompt, AutoDream and SessionMemory: extraction policy, model choice and
 * date stamps.
 */

/**
 * Resolves the auto_extract setting. Unset and true both mean "signals" (extract when needed). Only an explicit false
 * turns extraction off; removing the field restores the default.
 */
export function resolveExtractPolicy(value: boolean | "signals" | "always" | undefined): "off" | "signals" | "always" {
  if (value === false) return "off"
  if (value === "always") return "always"
  return "signals"
}

/**
 * Model for memory processing: memory.model, then small_model, then fallback. Extraction, consolidation (dream) and
 * session note compaction (session-memory) share this choice so they stay consistent.
 */
export async function pickMemoryModel(fallback: Message.UserInfo["model"]) {
  const cfg = await Config.get()
  const raw = [cfg.memory?.model, cfg.small_model].find((item) => typeof item === "string" && item.trim().length > 0)
  return raw ? Provider.parseModel(raw) : fallback
}

/**
 * Local date stamp YYYY-MM-DD, independent of the system locale, sortable and stable across environments.
 * Used to date memory files, unlike the UI formatting in util/locale.ts (toLocaleDateString).
 */
export function localDate(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
