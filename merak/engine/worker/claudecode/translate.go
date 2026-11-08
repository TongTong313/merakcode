// Package claudecode translates Claude Code's stream-json output into engine events.
package claudecode

import (
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type wireBlock struct {
	Thinking  string          `json:"thinking"`
	Signature string          `json:"signature"`
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	CallID    string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

type wireUsage struct {
	Input  int `json:"input_tokens"`
	Output int `json:"output_tokens"`
	Read   int `json:"cache_read_input_tokens"`
	Write  int `json:"cache_creation_input_tokens"`
}

func (u wireUsage) engine() model.Usage {
	return model.Usage{Input: u.Input + u.Read + u.Write, Output: u.Output, CacheRead: u.Read, CacheWrite: u.Write}
}

// Translate preserves the shared message and tool payloads; the runner supplies event IDs and causes.
func Translate(line []byte, scope event.Scope, actor event.Actor) ([]event.Event, error) {
	var raw struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Message struct {
			Content json.RawMessage `json:"content"`
			Usage   wireUsage       `json:"usage"`
		} `json:"message"`
		Event struct {
			Type  string    `json:"type"`
			Delta wireBlock `json:"delta"`
		} `json:"event"`
	}
	if err := json.Unmarshal(line, &raw); err != nil {
		return nil, err
	}
	var facts []event.Event
	emit := func(kind event.Type, payload any) {
		body, _ := json.Marshal(payload)
		facts = append(facts, event.Event{Type: kind, Stream: event.Stream("session:" + scope.Session), Scope: scope, Actor: actor, Payload: body})
	}
	progress := func() { emit(tool.Progressed, tool.Progress{Raw: append(json.RawMessage(nil), line...)}) }
	var blocks []wireBlock
	if (raw.Type == "assistant" || raw.Type == "user") && json.Unmarshal(raw.Message.Content, &blocks) != nil {
		progress()
		return facts, nil
	}
	switch raw.Type {
	case "result":
	case "system":
		if raw.Subtype != "init" {
			emit(tool.Progressed, tool.Progress{Raw: append(json.RawMessage(nil), line...)})
		}
	case "stream_event":
		if raw.Event.Type == "content_block_delta" && raw.Event.Delta.Type == "text_delta" {
			emit(session.MessageDelta, model.Chunk{Kind: model.Text, Text: raw.Event.Delta.Text})
		} else if raw.Event.Type == "content_block_delta" && raw.Event.Delta.Type == "thinking_delta" {
			emit(session.MessageDelta, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Text: raw.Event.Delta.Thinking, Provider: "claude-code"}})
		} else {
			progress()
		}
	case "assistant":
		message := session.Completion{Message: model.Message{Role: model.Assistant}, Usage: raw.Message.Usage.engine()}
		var calls []model.ToolCall
		unknown := false
		for _, block := range blocks {
			switch block.Type {
			case "text":
				message.Parts = append(message.Parts, model.Part{Text: block.Text})
			case "thinking":
				opaque, _ := json.Marshal(map[string]string{"signature": block.Signature})
				message.Parts = append(message.Parts, model.Part{Reasoning: &model.Reasoning{Text: block.Thinking, Provider: "claude-code", Opaque: opaque}})
			case "tool_use":
				call := model.ToolCall{ID: block.ID, Name: block.Name, Input: block.Input}
				message.Parts = append(message.Parts, model.Part{ToolCall: &call})
				calls = append(calls, call)
			default:
				unknown = true
			}
		}
		if len(message.Parts) > 0 {
			emit(session.MessageCompleted, message)
		}
		if unknown {
			progress()
		}
		for _, call := range calls {
			emit(tool.Called, call)
		}
	case "user":
		for _, block := range blocks {
			if block.Type != "tool_result" {
				progress()
				continue
			}
			var text string
			if err := json.Unmarshal(block.Content, &text); err != nil {
				var parts []wireBlock
				if err := json.Unmarshal(block.Content, &parts); err != nil {
					return nil, err
				}
				for _, part := range parts {
					if part.Type == "text" {
						text += part.Text
					}
				}
			}
			emit(tool.Completed, tool.Completion{CallID: block.CallID, Result: tool.Result{Parts: []model.Part{{Text: text}}, IsError: block.IsError}})
		}
	default:
		emit(tool.Progressed, tool.Progress{Raw: append(json.RawMessage(nil), line...)})
	}
	return facts, nil
}
