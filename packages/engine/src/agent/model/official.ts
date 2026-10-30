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

export type OfficialID = (typeof OFFICIAL_PROVIDER_IDS)[number]

/** Chat endpoint, SDK package and interleaved reasoning field for one official provider. */
export type OfficialProvider = {
  id: OfficialID
  name: string
  npm: string
  /** Base URL of the chat API. List URLs are derived from this, except Bailian which uses /api/v1/models. */
  api: string
  env: string[]
  interleaved: false | { field: "reasoning_content" | "reasoning_details" }
}

export const OFFICIAL: Record<OfficialID, OfficialProvider> = {
  "alibaba-cn": {
    id: "alibaba-cn",
    name: "Alibaba (China)",
    npm: "@ai-sdk/openai-compatible",
    api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    env: ["DASHSCOPE_API_KEY"],
    interleaved: { field: "reasoning_content" },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
    interleaved: { field: "reasoning_content" },
  },
  zhipuai: {
    id: "zhipuai",
    name: "Zhipu AI",
    npm: "@ai-sdk/openai-compatible",
    api: "https://open.bigmodel.cn/api/paas/v4",
    env: ["ZHIPU_API_KEY"],
    interleaved: { field: "reasoning_content" },
  },
  "moonshotai-cn": {
    id: "moonshotai-cn",
    name: "Moonshot AI (China)",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.moonshot.cn/v1",
    env: ["MOONSHOT_API_KEY"],
    interleaved: { field: "reasoning_content" },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    interleaved: false,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com",
    env: ["ANTHROPIC_API_KEY"],
    interleaved: false,
  },
  google: {
    id: "google",
    name: "Google",
    npm: "@ai-sdk/google",
    api: "https://generativelanguage.googleapis.com/v1beta",
    env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    interleaved: false,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    api: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    interleaved: { field: "reasoning_details" },
  },
}

export function official(id: string): OfficialProvider | undefined {
  if ((OFFICIAL_PROVIDER_IDS as readonly string[]).includes(id)) return OFFICIAL[id as OfficialID]
  return undefined
}

/** Providers whose gateway effort names match the official parameter, so the public catalog may fill efforts. */
export const PUBLIC_EFFORT_PROVIDERS = new Set<string>(["anthropic", "openai", "google"])

/**
 * Homepage defaults for an official catalog.
 * `exact` turns those ids on and nothing else. `tiers` turns on one id per word.
 * An empty tier is the model with no extra word, such as glm-5.3.
 * An id with no version number wins; otherwise the highest version wins.
 * A provider with neither stays off. A new tier word stays off until it is added here.
 */
export const HOMEPAGE_LINES: Record<OfficialID, { exact?: readonly string[]; tiers?: readonly string[] }> = {
  "alibaba-cn": { exact: ["qwen-plus", "qwen-max"] },
  openai: { tiers: ["astra", "sol"] },
  anthropic: { tiers: ["opus", "sonnet"] },
  "moonshotai-cn": { tiers: ["pro", "flash"] },
  deepseek: { tiers: ["flash", "pro"] },
  zhipuai: { tiers: ["", "flash", "pro"] },
  google: { tiers: ["pro", "flash"] },
  openrouter: {},
}
