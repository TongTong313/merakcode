export type FallbackEntry = {
  provider: string
  family: string
  efforts?: string[]
  canDisable?: boolean
  defaultEffort?: string
  temperature?: boolean
  context?: number
  output?: number
  source: string
  checked: string
}

const CHECKED = "2026-10-25"
const CLAUDE = "https://platform.claude.com/docs/en/build-with-claude/effort"
const OPENAI = "https://developers.openai.com/api/docs/guides/reasoning"
const OPENAI_LATEST = "https://developers.openai.com/api/docs/guides/latest-model"
const GOOGLE = "https://ai.google.dev/gemini-api/docs/generate-content/thinking"
const BAILIAN = "https://platform.qianwenai.com/docs/api-reference/chat/dashscope"
const ZHIPU = "https://docs.z.ai/guides/capabilities/thinking"
const MOONSHOT = "https://platform.kimi.ai/docs/guide/use-thinking-models"
const DEEPSEEK = "https://api-docs.deepseek.com/guides/thinking_mode"

const CLAUDE_ALL = ["low", "medium", "high", "xhigh", "max"]
const CLAUDE_MAX = ["low", "medium", "high", "max"]

function row(entry: Omit<FallbackEntry, "checked">): FallbackEntry {
  return { ...entry, checked: CHECKED }
}

function claude(families: string[], efforts: string[]) {
  return families.map((family) =>
    row({ provider: "anthropic", family, efforts, canDisable: true, defaultEffort: "high", source: CLAUDE }),
  )
}

/**
 * Official-doc values used only when the provider list and the public catalog both omit a field.
 * Keyed by provider and model-family prefix because the same model accepts different efforts on different hosts.
 * Claude models missing here do not support effort.
 */
export const FALLBACK: FallbackEntry[] = [
  row({
    provider: "anthropic",
    family: "claude-opus-5-5",
    efforts: CLAUDE_ALL,
    canDisable: false,
    defaultEffort: "medium",
    source: CLAUDE,
  }),
  row({
    provider: "anthropic",
    family: "claude-haiku-5-5",
    efforts: CLAUDE_ALL,
    canDisable: true,
    defaultEffort: "medium",
    source: CLAUDE,
  }),
  ...claude(
    [
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
    ],
    CLAUDE_ALL,
  ),
  ...claude(["claude-mythos-preview", "claude-opus-4-6", "claude-sonnet-4-6"], CLAUDE_MAX),
  ...claude(["claude-opus-4-5"], ["low", "medium", "high"]),
  row({
    provider: "openai",
    family: "gpt-6-1-sol",
    efforts: ["low", "medium", "high", "xhigh"],
    canDisable: false,
    defaultEffort: "medium",
    temperature: false,
    source: OPENAI_LATEST,
  }),
  row({
    provider: "openai",
    family: "gpt-6-astra",
    efforts: ["low", "medium", "high", "xhigh"],
    canDisable: false,
    temperature: false,
    source: OPENAI_LATEST,
  }),
  row({
    provider: "openai",
    family: "gpt-5-5",
    efforts: ["none", "low", "medium", "high", "xhigh"],
    canDisable: true,
    defaultEffort: "medium",
    temperature: false,
    source: OPENAI,
  }),
  row({ provider: "openai", family: "gpt-5", temperature: false, source: OPENAI_LATEST }),
  row({
    provider: "google",
    family: "gemini-4-argon",
    efforts: ["low", "medium", "high"],
    canDisable: false,
    defaultEffort: "medium",
    source: GOOGLE,
  }),
  row({
    provider: "google",
    family: "gemini-3-8-flash",
    efforts: ["low", "medium", "high"],
    canDisable: false,
    defaultEffort: "medium",
    source: GOOGLE,
  }),
  row({
    provider: "google",
    family: "gemini-3-6-flash",
    efforts: ["minimal", "low", "medium", "high"],
    canDisable: false,
    defaultEffort: "medium",
    source: GOOGLE,
  }),
  ...["gemini-3-5-flash-lite", "gemini-3-1-flash-lite"].map((family) =>
    row({
      provider: "google",
      family,
      efforts: ["minimal", "low", "medium", "high"],
      canDisable: false,
      defaultEffort: "minimal",
      source: GOOGLE,
    }),
  ),
  row({ provider: "google", family: "gemini-3-1-pro", defaultEffort: "high", source: GOOGLE }),
  row({
    provider: "google",
    family: "gemini-3-flash",
    efforts: ["minimal", "low", "medium", "high"],
    canDisable: false,
    defaultEffort: "high",
    source: GOOGLE,
  }),
  row({ provider: "google", family: "gemini-2-5-pro", canDisable: false, source: GOOGLE }),
  row({ provider: "google", family: "gemini-2-5", canDisable: true, source: GOOGLE }),
  row({
    provider: "alibaba-cn",
    family: "qwen3-8",
    efforts: ["low", "medium", "xhigh"],
    canDisable: true,
    defaultEffort: "xhigh",
    source: BAILIAN,
  }),
  ...["glm-5-3", "kimi-k3"].map((family) =>
    row({
      provider: "alibaba-cn",
      family,
      efforts: ["low", "high", "max"],
      canDisable: false,
      defaultEffort: "max",
      source: BAILIAN,
    }),
  ),
  ...["deepseek-v4-flash", "deepseek-v4-1-flash"].map((family) =>
    row({
      provider: "alibaba-cn",
      family,
      efforts: ["low", "high", "max"],
      canDisable: true,
      defaultEffort: "high",
      source: BAILIAN,
    }),
  ),
  ...["deepseek-v4-pro", "glm-5-2", "glm-5-1", "glm-5"].map((family) =>
    row({
      provider: "alibaba-cn",
      family,
      efforts: ["high", "max"],
      canDisable: true,
      defaultEffort: "high",
      source: BAILIAN,
    }),
  ),
  row({
    provider: "zhipuai",
    family: "glm-5-3",
    efforts: ["low", "high", "max"],
    canDisable: false,
    defaultEffort: "max",
    source: ZHIPU,
  }),
  row({
    provider: "zhipuai",
    family: "glm-5-2",
    efforts: ["high", "max"],
    canDisable: true,
    defaultEffort: "max",
    source: ZHIPU,
  }),
  row({
    provider: "moonshotai-cn",
    family: "kimi-k3",
    efforts: ["low", "high", "max"],
    canDisable: false,
    defaultEffort: "max",
    source: MOONSHOT,
  }),
  row({ provider: "moonshotai-cn", family: "kimi-k2-7", canDisable: false, source: MOONSHOT }),
  row({ provider: "moonshotai-cn", family: "kimi-k2-6", canDisable: true, source: MOONSHOT }),
  row({
    provider: "deepseek",
    family: "deepseek",
    efforts: ["low", "high", "max"],
    canDisable: true,
    defaultEffort: "high",
    source: DEEPSEEK,
  }),
]
