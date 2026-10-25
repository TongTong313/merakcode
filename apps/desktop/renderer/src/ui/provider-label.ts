const OFFICIAL_ZH: Record<string, string> = {
  "alibaba-cn": "阿里云百炼",
  zhipuai: "智谱",
  "moonshotai-cn": "月之暗面",
}

/** Chinese labels for official providers. English and configured providers keep the stored name. */
export function providerLabel(
  provider: { id: string; name: string; origin?: "official" | "configured" },
  language: "zh" | "en",
) {
  if (provider.origin === "official" && language === "zh") return OFFICIAL_ZH[provider.id] ?? provider.name
  return provider.name
}
