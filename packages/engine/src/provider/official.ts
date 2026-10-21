/** Providers a user can connect from the built-in catalog. Anything else is a custom provider in config. */
export const OFFICIAL_PROVIDER_IDS = [
  "alibaba-cn",
  "deepseek",
  "zhipuai",
  "moonshotai-cn",
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const

/** Keeps the official providers, in list order, and drops the rest of a models.dev catalog. */
export function selectOfficial<T>(catalog: Record<string, T>): Record<string, T> {
  const selected: Record<string, T> = {}
  for (const id of OFFICIAL_PROVIDER_IDS) {
    if (id in catalog) selected[id] = catalog[id]
  }
  return selected
}
