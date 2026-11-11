package openai

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type wireCall struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Extra    json.RawMessage `json:"extra_content,omitempty"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type callSignature struct {
	CallID string          `json:"callId"`
	Extra  json.RawMessage `json:"extra"`
}

type wireMessage struct {
	Role           string     `json:"role"`
	Content        any        `json:"content"`
	Calls          []wireCall `json:"tool_calls,omitempty"`
	CallID         string     `json:"tool_call_id,omitempty"`
	Reasoning      string     `json:"-"`
	ReasoningField string     `json:"-"`
}

func (m wireMessage) MarshalJSON() ([]byte, error) {
	body := map[string]any{"role": m.Role, "content": m.Content}
	if len(m.Calls) > 0 {
		body["tool_calls"] = m.Calls
	}
	if m.CallID != "" {
		body["tool_call_id"] = m.CallID
	}
	if m.Reasoning != "" && m.ReasoningField != "" {
		body[m.ReasoningField] = m.Reasoning
	}
	return json.Marshal(body)
}

type wireTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

func encode(req model.Request, config Config) map[string]any {
	messages := make([]wireMessage, 0, len(req.Messages)+1)
	if req.System != "" {
		messages = append(messages, wireMessage{Role: "system", Content: req.System})
	}
	for _, message := range req.Messages {
		if message.Role == model.Tool {
			var media []model.Part
			for _, part := range message.Parts {
				if part.ToolResult == nil {
					continue
				}
				result := part.ToolResult
				content := textParts(result.Parts)
				if result.IsError {
					content = "Error: " + content
				}
				messages = append(messages, wireMessage{Role: "tool", CallID: result.CallID, Content: content})
				for _, content := range result.Parts {
					if content.Image == nil && content.Document == nil {
						continue
					}
					media = append(media, model.Part{Text: "Content from tool call " + result.CallID + ":"}, content)
				}
			}
			if len(media) > 0 {
				messages = append(messages, wireMessage{Role: "user", Content: contentParts(media)})
			}
			continue
		}
		wire := wireMessage{Role: string(message.Role), Content: contentParts(message.Parts)}
		signatures := make(map[string]json.RawMessage)
		if config.Name == "gemini" {
			for _, part := range message.Parts {
				if part.Reasoning == nil || part.Reasoning.Provider != config.Name {
					continue
				}
				var signature callSignature
				if json.Unmarshal(part.Reasoning.Opaque, &signature) == nil && signature.CallID != "" {
					signatures[signature.CallID] = signature.Extra
				}
			}
		}
		for _, part := range message.Parts {
			if part.Reasoning != nil && part.Reasoning.Provider == config.Name && config.SendReasoning {
				wire.Reasoning += part.Reasoning.Text
				wire.ReasoningField = config.ReasoningField
			}
			if part.ToolCall == nil {
				continue
			}
			call := wireCall{ID: part.ToolCall.ID, Type: "function", Extra: signatures[part.ToolCall.ID]}
			call.Function.Name = part.ToolCall.Name
			call.Function.Arguments = string(part.ToolCall.Input)
			wire.Calls = append(wire.Calls, call)
		}
		messages = append(messages, wire)
	}
	body := map[string]any{
		"model": req.Model, "messages": messages, "stream": true,
		"stream_options": map[string]bool{"include_usage": true},
	}
	if req.MaxTokens > 0 {
		key := "max_tokens"
		if config.Name == "openai" {
			key = "max_completion_tokens"
		}
		body[key] = req.MaxTokens
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		body["top_p"] = *req.TopP
	}
	if len(req.Tools) > 0 {
		tools := make([]wireTool, 0, len(req.Tools))
		for _, spec := range req.Tools {
			wire := wireTool{Type: "function"}
			wire.Function.Name = spec.Name
			wire.Function.Description = spec.Description
			wire.Function.Parameters = spec.Input
			tools = append(tools, wire)
		}
		body["tools"] = tools
	}
	config.applyThinking(body, req)
	return body
}

func contentParts(parts []model.Part) any {
	var content []map[string]any
	media := false
	for _, part := range parts {
		switch {
		case part.Text != "":
			content = append(content, map[string]any{"type": "text", "text": part.Text})
		case part.Image != nil:
			media = true
			url := part.Image.URL
			if url == "" {
				url = "data:" + part.Image.MIME + ";base64," + base64.StdEncoding.EncodeToString(part.Image.Data)
			}
			content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": url}})
		case part.Document != nil:
			media = true
			doc := part.Document
			content = append(content, map[string]any{"type": "file", "file": map[string]string{"filename": doc.Name, "file_data": "data:" + doc.MIME + ";base64," + base64.StdEncoding.EncodeToString(doc.Data)}})
		}
	}
	if media {
		return content
	}
	return textParts(parts)
}

func textParts(parts []model.Part) string {
	var text strings.Builder
	for _, part := range parts {
		text.WriteString(part.Text)
	}
	return text.String()
}
