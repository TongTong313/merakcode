package openai

import (
	"github.com/TongTong313/merakcode/merak/engine/model"
	"strings"
)

func Builtin(name string) (Config, bool) {
	configs := map[string]Config{
		"openai":     {Name: "openai", BaseURL: "https://api.openai.com/v1", ReasoningField: "reasoning_content", NativePDF: true, thinking: "effort"},
		"deepseek":   {Name: "deepseek", BaseURL: "https://api.deepseek.com", ReasoningField: "reasoning_content", SendReasoning: true, thinking: "deepseek"},
		"moonshot":   {Name: "moonshot", BaseURL: "https://api.moonshot.ai/v1", ReasoningField: "reasoning_content", SendReasoning: true, thinking: "toggle"},
		"zhipu":      {Name: "zhipu", BaseURL: "https://open.bigmodel.cn/api/paas/v4", ReasoningField: "reasoning_content", SendReasoning: true, thinking: "toggle"},
		"dashscope":  {Name: "dashscope", BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", ReasoningField: "reasoning_content", thinking: "budget"},
		"gemini":     {Name: "gemini", BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", ReasoningField: "reasoning_content", thinking: "gemini"},
		"openrouter": {Name: "openrouter", BaseURL: "https://openrouter.ai/api/v1", ReasoningField: "reasoning", SendReasoning: true, NativePDF: true, thinking: "effort"},
	}
	config, ok := configs[name]
	return config, ok
}

func (c Config) applyThinking(body map[string]any, req model.Request) {
	if req.Thinking == "" {
		return
	}
	enabled := req.Thinking != model.ThinkingOff
	state := "disabled"
	if enabled {
		state = "enabled"
	}
	switch c.thinking {
	case "gemini":
		effort := req.Thinking
		if effort == model.ThinkingMax || effort == model.ThinkingXHigh {
			effort = model.ThinkingHigh
		}
		if effort == model.ThinkingOff {
			if strings.HasPrefix(req.Model, "gemini-2.5-") && !strings.Contains(req.Model, "pro") {
				body["reasoning_effort"] = "none"
				return
			}
			effort = model.ThinkingLow
		}
		body["reasoning_effort"] = string(effort)
	case "effort":
		effort := string(req.Thinking)
		if !enabled {
			effort = "none"
		}
		body["reasoning_effort"] = effort
	case "deepseek":
		if req.Model == "deepseek-chat" || req.Model == "deepseek-reasoner" {
			body["model"] = "deepseek-chat"
			if enabled {
				body["model"] = "deepseek-reasoner"
			}
			return
		}
		body["thinking"] = map[string]any{"type": state}
		if enabled {
			body["reasoning_effort"] = string(req.Thinking)
		}
	case "toggle":
		if c.Name == "moonshot" && strings.HasPrefix(req.Model, "kimi-k3") {
			body["reasoning_effort"] = string(req.Thinking)
			return
		}
		thinking := map[string]any{"type": state}
		if c.Name == "zhipu" && c.SendReasoning {
			thinking["clear_thinking"] = false
		}
		body["thinking"] = thinking
		if c.Name == "zhipu" && req.Model == "glm-5.3" {
			body["reasoning_effort"] = string(req.Thinking)
		}
	case "budget":
		body["enable_thinking"] = enabled
		if enabled {
			body["thinking_budget"] = map[model.Thinking]int{model.ThinkingLow: 1024, model.ThinkingMedium: 4096, model.ThinkingHigh: 8192, model.ThinkingXHigh: 16384, model.ThinkingMax: 32768}[req.Thinking]
		}
	}
}
