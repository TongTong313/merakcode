package pi

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
)

type block struct {
	Type, Text, Thinking, ThinkingSignature, ID, Name string
	Arguments                                         json.RawMessage
}

func parts(blocks []block) []model.Part {
	var out []model.Part
	for _, b := range blocks {
		switch b.Type {
		case "text":
			out = append(out, model.Part{Text: b.Text})
		case "thinking":
			opaque, _ := json.Marshal(map[string]string{"signature": b.ThinkingSignature})
			out = append(out, model.Part{Reasoning: &model.Reasoning{Text: b.Thinking, Provider: "pi", Opaque: opaque}})
		case "toolCall":
			out = append(out, model.Part{ToolCall: &model.ToolCall{ID: b.ID, Name: b.Name, Input: b.Arguments}})
		}
	}
	return out
}
func translate(ctx context.Context, j *stdio.Journal, line json.RawMessage) error {
	var raw struct {
		Type, ToolCallID, ToolName string
		Args                       json.RawMessage
		IsError                    bool
		Result                     struct{ Content []block }
		AssistantMessageEvent      struct{ Type, Delta string }
		Message                    struct {
			Role, StopReason string
			Content          []block
			Usage            struct {
				Input, Output, CacheRead, CacheWrite int
				Cost                                 struct{ Total *float64 }
			}
		}
	}
	if err := json.Unmarshal(line, &raw); err != nil {
		return err
	}
	switch raw.Type {
	case "agent_start", "agent_end", "turn_start", "turn_end", "message_start":
		return nil
	case "message_update":
		delta := raw.AssistantMessageEvent
		chunk := model.Chunk{Kind: model.Text, Text: delta.Delta}
		if delta.Type == "thinking_delta" {
			chunk = model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Text: delta.Delta, Provider: "pi"}}
		} else if delta.Type != "text_delta" {
			return nil
		}
		return j.Delta(ctx, chunk)
	case "message_end":
		if raw.Message.Role != "assistant" {
			return nil
		}
		u := raw.Message.Usage
		usage := model.Usage{Input: u.Input + u.CacheRead + u.CacheWrite, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}
		if u.Cost.Total != nil {
			usage.Cost = *u.Cost.Total
			usage.CostKnown = true
		}
		if err := j.Message(ctx, session.Completion{Message: model.Message{Role: model.Assistant, Parts: parts(raw.Message.Content)}, Usage: usage}); err != nil {
			return err
		}
		if raw.Message.StopReason == "error" || raw.Message.StopReason == "aborted" {
			return errors.New("pi did not finish its response")
		}
		return nil
	case "tool_execution_start":
		return j.Call(ctx, model.ToolCall{ID: raw.ToolCallID, Name: raw.ToolName, Input: raw.Args})
	case "tool_execution_end":
		return j.Complete(ctx, raw.ToolCallID, tool.Result{Parts: parts(raw.Result.Content), IsError: raw.IsError})
	default:
		_, err := j.Emit(ctx, tool.Progressed, tool.Progress{Raw: line}, "")
		return err
	}
}
