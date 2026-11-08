package catalog

import "github.com/TongTong313/merakcode/merak/engine/model"

// Rates were checked against the provider references in sources.md on 2026-11-08.
func builtins() []Model {
	all := []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax}
	toggle := []model.Thinking{model.ThinkingOff, model.ThinkingHigh}
	three := []model.Thinking{model.ThinkingLow, model.ThinkingHigh, model.ThinkingMax}
	return []Model{
		{Provider: "anthropic", ID: "claude-sonnet-5-5", Window: 1000000, MaxOutput: 128000, Price: Price{Input: 2, Output: 10, CacheRead: .1, CacheWrite: 2.5, Currency: "USD"}, Caps: Caps{Tools: true, Vision: true, PDF: true}, Thinking: all[1:], Source: "builtin"},
		{Provider: "gemini", ID: "gemini-2.5-flash", Window: 1048576, MaxOutput: 65536, Caps: Caps{Tools: true, Vision: true}, Thinking: []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh}, Source: "builtin", Unknown: []string{"price"}},
		{Provider: "openai", ID: "gpt-5", Window: 400000, MaxOutput: 128000, Price: Price{Input: 1.25, Output: 10, CacheRead: 0.125, Currency: "USD"}, Thinking: []model.Thinking{model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh}, Source: "builtin"},
		{Provider: "deepseek", ID: "deepseek-flash", Window: 1000000, MaxOutput: 384000, Price: Price{Input: 0.3, Output: 1.2, CacheRead: 0.006, Currency: "USD"}, Thinking: []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingHigh, model.ThinkingMax}, Source: "builtin"},
		{Provider: "deepseek", ID: "deepseek-v4-pro", Window: 1000000, MaxOutput: 384000, Price: Price{Input: 1.32, Output: 3.96, CacheRead: 0.044, Currency: "USD"}, Thinking: []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingHigh, model.ThinkingMax}, Source: "builtin"},
		{Provider: "moonshot", ID: "kimi-k2.6", Window: 262144, MaxOutput: 8192, Thinking: toggle, Source: "builtin", Unknown: []string{"maxOutput", "price"}},
		{Provider: "moonshot", ID: "kimi-k3", Window: 1048576, MaxOutput: 8192, Thinking: three, Source: "builtin", Unknown: []string{"maxOutput", "price"}},
		{Provider: "moonshot", ID: "kimi-k3.1-pro", Window: 1048576, MaxOutput: 8192, Thinking: three, Source: "builtin", Unknown: []string{"maxOutput", "price"}},
		{Provider: "zhipu", ID: "glm-5.3", Window: 1000000, MaxOutput: 131072, Price: Price{Input: 8, Output: 28, CacheRead: 2, Currency: "CNY"}, Thinking: three, Source: "builtin"},
		{Provider: "zhipu", ID: "glm-4.7", Window: 200000, MaxOutput: 131072, Thinking: toggle, Source: "builtin", Price: Price{Currency: "CNY", Tiers: []Tier{
			{MaxInput: 31999, MaxOutput: 199, Price: Price{Input: 2, Output: 8, CacheRead: 0.4, Currency: "CNY"}},
			{MaxInput: 31999, Price: Price{Input: 3, Output: 14, CacheRead: 0.6, Currency: "CNY"}},
			{Price: Price{Input: 4, Output: 16, CacheRead: 0.8, Currency: "CNY"}},
		}}},
		{Provider: "dashscope", ID: "qwen3.5-plus", Window: 1000000, MaxOutput: 65536, Thinking: all, Source: "builtin", Price: Price{Currency: "CNY", Tiers: []Tier{
			{MaxInput: 128000, Price: Price{Input: 0.8, Output: 4.8, CacheRead: 0.08, CacheWrite: 1, Currency: "CNY"}},
			{MaxInput: 256000, Price: Price{Input: 2, Output: 12, CacheRead: 0.2, CacheWrite: 2.5, Currency: "CNY"}},
			{Price: Price{Input: 4, Output: 24, CacheRead: 0.4, CacheWrite: 5, Currency: "CNY"}},
		}}},
	}
}
