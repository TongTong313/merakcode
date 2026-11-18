# Built-in catalog references

Checked on 2026-11-08. Costs are estimates at published list rates, without taxes, account discounts, or currency conversion. Relay model names reuse the upstream list rates; relay invoices can differ. DeepSeek uses peak list rates; off-peak discounts are not included. DashScope uses the Beijing endpoint and CNY rates.

- [OpenAI GPT-5](https://developers.openai.com/api/docs/models/gpt-5): window, output limit, thinking levels, USD prices. This is a legacy model entry, not a default model recommendation.
- [Claude model limits](https://platform.claude.com/docs/en/models/overview) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing): Sonnet 5.5 limits and USD rates, including 5-minute writes and cache reads. Live models with no matching built-in price remain unknown until overridden or matched to a published OpenRouter model.
- [Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash?authuser=3&hl=en): input/output limits and image/tool capabilities. Pricing remains unknown. Availability depends on the provider account; the catalog is not an availability guarantee.
- [DeepSeek models and prices](https://api-docs.deepseek.com/quick_start/pricing/): current model IDs, window, output limits and peak USD prices.
- [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/): current thinking and effort fields. The chat/reasoner aliases retain the design's legacy mapping.
- [Kimi models](https://platform.kimi.ai/docs/models) and [pricing](https://platform.kimi.ai/docs/pricing/chat): context limits. The public pricing page omitted rate values when checked; prices remain unknown. Output limits use the conservative 8192 default and are marked unknown.
- [Kimi reasoning effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort): K3 effort levels; K2 uses the enable/disable configuration.
- [Zhipu pricing](https://docs.bigmodel.cn/cn/guide/start/pricing) and [Chat Completions](https://docs.bigmodel.cn/api-reference/模型-api/对话补全): windows, output limits, thinking controls and CNY price tiers.
- [Qwen3.5 Plus](https://help.aliyun.com/zh/model-studio/qwen3-5-plus): Beijing limits and CNY price tiers. The engine maps its five enabled levels to budgets of 1024, 4096, 8192, 16384 and 32768 tokens.

The SSE fixtures in `../openai/testdata` are sanitized protocol examples based on these official formats. They are offline regression fixtures; they do not prove live account access or current billing.
