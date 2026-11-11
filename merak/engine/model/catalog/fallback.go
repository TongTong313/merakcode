package catalog

import (
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// fallbackRow gives the thinking levels of a model family when neither the provider's list nor the public catalog
// does. The values come from each provider's thinking documentation, checked on 2026-10-25. The same model accepts
// different levels on different hosts, so rows are keyed by host and family prefix.
type fallbackRow struct {
	host       string
	family     string
	efforts    []string
	canDisable bool
	preferred  string
}

var (
	claudeAll = []string{"low", "medium", "high", "xhigh", "max"}
	claudeMax = []string{"low", "medium", "high", "max"}
)

func claudeRows(families []string, efforts []string) []fallbackRow {
	rows := make([]fallbackRow, 0, len(families))
	for _, family := range families {
		rows = append(rows, fallbackRow{"anthropic", family, efforts, true, "high"})
	}
	return rows
}

func buildFallback() []fallbackRow {
	rows := []fallbackRow{
		{"anthropic", "claude-opus-5-5", claudeAll, false, "medium"},
		{"anthropic", "claude-haiku-5-5", claudeAll, true, "medium"},
	}
	rows = append(rows, claudeRows([]string{"claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5-5", "claude-sonnet-5"}, claudeAll)...)
	rows = append(rows, claudeRows([]string{"claude-mythos-preview", "claude-opus-4-6", "claude-sonnet-4-6"}, claudeMax)...)
	rows = append(rows, claudeRows([]string{"claude-opus-4-5"}, []string{"low", "medium", "high"})...)
	return append(rows,
		fallbackRow{"openai", "gpt-6-1-sol", []string{"low", "medium", "high", "xhigh"}, false, "medium"},
		fallbackRow{"openai", "gpt-6-astra", []string{"low", "medium", "high", "xhigh"}, false, ""},
		fallbackRow{"openai", "gpt-5-5", []string{"none", "low", "medium", "high", "xhigh"}, true, "medium"},
		fallbackRow{"google", "gemini-4-argon", []string{"low", "medium", "high"}, false, "medium"},
		fallbackRow{"google", "gemini-3-8-flash", []string{"low", "medium", "high"}, false, "medium"},
		fallbackRow{"google", "gemini-3-6-flash", []string{"minimal", "low", "medium", "high"}, false, "medium"},
		fallbackRow{"google", "gemini-3-5-flash-lite", []string{"minimal", "low", "medium", "high"}, false, "minimal"},
		fallbackRow{"google", "gemini-3-1-flash-lite", []string{"minimal", "low", "medium", "high"}, false, "minimal"},
		fallbackRow{"google", "gemini-3-1-pro", nil, false, "high"},
		fallbackRow{"google", "gemini-3-flash", []string{"minimal", "low", "medium", "high"}, false, "high"},
		fallbackRow{"google", "gemini-2-5-pro", nil, false, ""},
		fallbackRow{"google", "gemini-2-5", nil, true, ""},
		fallbackRow{"alibaba-cn", "qwen3-8", []string{"low", "medium", "xhigh"}, true, "xhigh"},
		fallbackRow{"alibaba-cn", "glm-5-3", []string{"low", "high", "max"}, false, "max"},
		fallbackRow{"alibaba-cn", "kimi-k3", []string{"low", "high", "max"}, false, "max"},
		fallbackRow{"alibaba-cn", "deepseek-v4-flash", []string{"low", "high", "max"}, true, "high"},
		fallbackRow{"alibaba-cn", "deepseek-v4-1-flash", []string{"low", "high", "max"}, true, "high"},
		fallbackRow{"alibaba-cn", "deepseek-v4-pro", []string{"high", "max"}, true, "high"},
		fallbackRow{"alibaba-cn", "glm-5-2", []string{"high", "max"}, true, "high"},
		fallbackRow{"alibaba-cn", "glm-5-1", []string{"high", "max"}, true, "high"},
		fallbackRow{"alibaba-cn", "glm-5", []string{"high", "max"}, true, "high"},
		fallbackRow{"zhipuai", "glm-5-3", []string{"low", "high", "max"}, false, "max"},
		fallbackRow{"zhipuai", "glm-5-2", []string{"high", "max"}, true, "max"},
		fallbackRow{"moonshotai-cn", "kimi-k3", []string{"low", "high", "max"}, false, "max"},
		fallbackRow{"moonshotai-cn", "kimi-k2-7", nil, false, ""},
		fallbackRow{"moonshotai-cn", "kimi-k2-6", nil, true, ""},
		fallbackRow{"deepseek", "deepseek", []string{"low", "high", "max"}, true, "high"},
	)
}

var fallbackRows = buildFallback()

// hosts maps the provider ids used here, and the vendor prefixes relays put before a model id, to the hosts of the table.
var hosts = map[string]string{
	"anthropic": "anthropic", "openai": "openai", "gemini": "google", "google": "google", "dashscope": "alibaba-cn",
	"alibaba": "alibaba-cn", "qwen": "alibaba-cn", "zhipu": "zhipuai", "zhipuai": "zhipuai", "z-ai": "zhipuai",
	"moonshot": "moonshotai-cn", "moonshotai": "moonshotai-cn", "deepseek": "deepseek",
}

var thinkingOrder = []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax}

// normalize makes an id comparable with a family: lower case, dots as dashes, without a vendor prefix.
func normalize(id string) string {
	id = strings.ToLower(id)
	if at := strings.LastIndex(id, "/"); at >= 0 {
		id = id[at+1:]
	}
	return strings.ReplaceAll(id, ".", "-")
}

func levelOf(name string) model.Thinking {
	switch name {
	case "none":
		return model.ThinkingOff
	case "minimal":
		return model.ThinkingLow
	}
	return model.Thinking(name)
}

// fallbackFor finds the row of the longest family that starts the model id. A relay is told apart by the vendor
// prefix of the id; an unknown host is matched against every row.
func fallbackFor(provider, id string) (fallbackRow, bool) {
	host := hosts[provider]
	if vendor, _, ok := strings.Cut(strings.ToLower(id), "/"); ok && hosts[vendor] != "" {
		host = hosts[vendor]
	}
	name := normalize(id)
	var best fallbackRow
	found := false
	for _, row := range fallbackRows {
		if host != "" && row.host != host || !strings.HasPrefix(name, row.family) {
			continue
		}
		if !found || len(row.family) > len(best.family) {
			best, found = row, true
		}
	}
	return best, found
}

// fallbackOverride turns a row into the fields it knows. Nothing is returned for a model whose levels are unknown.
func fallbackOverride(provider, id string) (Override, bool) {
	row, ok := fallbackFor(provider, id)
	if !ok {
		return Override{}, false
	}
	var levels []model.Thinking
	if row.canDisable {
		levels = append(levels, model.ThinkingOff)
	}
	for _, name := range row.efforts {
		if level := levelOf(name); !slices.Contains(levels, level) {
			levels = append(levels, level)
		}
	}
	if len(row.efforts) == 0 && row.canDisable {
		levels = append(levels, model.ThinkingHigh)
	}
	if len(levels) == 0 {
		return Override{}, false
	}
	slices.SortFunc(levels, func(a, b model.Thinking) int { return slices.Index(thinkingOrder, a) - slices.Index(thinkingOrder, b) })
	result := Override{Thinking: &levels}
	if row.preferred != "" {
		preferred := levelOf(row.preferred)
		result.DefaultThinking = &preferred
	}
	return result, true
}
