# Provider adapters

The engine stores `Message` and `Part` values. Only `anthropic` imports the official Anthropic SDK. The two adapters share `testdata/conversation.json`, including text, reasoning, an image, concurrent tool calls and grouped tool results. Tests use local HTTP streams; they do not make paid requests or establish live account access.

## Requests and replay

- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create) maps thinking signatures and redacted thinking to provider-scoped `Reasoning.Opaque`. Compatibility endpoints use separate reasoning identities such as `deepseek-anthropic`.
- [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) uses adaptive thinking on 4.6 and later, with model-specific effort clamping. The product design maps Claude 5 `off` to `low`. Older models use bounded token budgets.
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) puts an explicit marker on the frozen system block and enables automatic conversation caching. `CacheHint.TTL` accepts `1h`; the default is `5m`. Total input includes uncached input, cache reads and cache writes. Final streamed counts replace earlier counts when present.
- [DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api/), [Kimi](https://platform.kimi.ai/docs/api/messages) and [Zhipu](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction) have built-in Messages endpoint configurations. Current effort controls use the shared catalog's supported levels.
- [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai) uses Chat Completions. Tool-call `extra_content` is stored in provider-scoped opaque reasoning and returned with its original call ID. This also follows the [OpenAI Agents SDK's Gemini signature handling](https://github.com/openai/openai-agents-python/blob/main/src/agents/extensions/models/litellm_model.py).
- [OpenRouter](https://openrouter.ai/docs/api/reference/overview) uses its compatible endpoint. Additional JSON parameters pass through, while the engine retains control over messages, model, tools, streaming and output limits.

Images use native Messages image blocks or Chat Completions `image_url` parts. [Anthropic PDFs](https://platform.claude.com/docs/en/build-with-claude/pdf-support) use document blocks. [OpenAI PDFs](https://developers.openai.com/api/docs/guides/file-inputs) use `file_data` and a filename. Tool images follow all Chat Completions tool responses in a user message because that protocol's tool content is text. Plain-text documents become text on compatible endpoints. Unsupported response fields and converted document blocks are listed in `message.completed.dropped`.

Compatible endpoints without native PDF support use the shared bounded extractor in `internal/platform/pdf`. A corrupt, unsupported or image-only document is omitted and listed in `dropped`; the request continues. `read_file` uses the same extractor for text PDFs and retains a native document when extraction is unavailable. See the extraction package's README for explicit format and resource limits.

## Catalog and command line

`catalog.New(Options)` merges built-in values, explicitly refreshed provider data and user overrides. `Refresh` reads [Anthropic model limits and capabilities](https://platform.claude.com/docs/en/api/models/list) and [OpenRouter model limits and per-token prices](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). Rates are converted to per-million-token units. A failed source keeps its previous data. Missing fields retain built-in values or conservative defaults. Unknown values remain marked. Refresh follows Anthropic pagination and rejects redirects without forwarding credentials.

Supply the same catalog to `engine.Deps` and provider options. The engine reads its window at each turn boundary and its price when recording usage. Provider adapters read thinking levels at each request.

`merak run --provider` accepts `anthropic`, `gemini`, `openrouter` and the existing compatible providers. `deepseek-anthropic`, `moonshot-anthropic` and `zhipu-anthropic` select Messages compatibility. These aliases reuse the base provider's `NAME_API_KEY`; `--base-url` selects a custom endpoint when starting an engine.

`merak models refresh [provider]` fetches the model list of one provider, or of every configured one, right away; the engine also does it in the background (at startup when the cache is older than an hour, then every hour, and when a key or address changes) and keeps the lists, with the public catalog, in its store so that they survive a restart and work offline. `MERAKCODE_DISABLE_CATALOG_FETCH=1` stops the background fetches. Sources use `NAME_API_KEY` and `NAME_BASE_URL`. Overrides are an array of objects with `provider`, `id`, and optional `window`, `maxOutput`, `price`, `caps` and `thinking` fields.
