package acp

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
)

type update struct {
	SessionUpdate, ToolCallID, Name, Title, Kind, Status string
	RawInput, RawOutput, Content                         json.RawMessage
}
type translation struct {
	journal *stdio.Journal
	parts   []model.Part
	calls   map[string]update
}

func (s *translation) flush(ctx context.Context) error {
	if len(s.parts) == 0 {
		return nil
	}
	err := s.journal.Message(ctx, session.Completion{Message: model.Message{Role: model.Assistant, Parts: s.parts}})
	s.parts = nil
	return err
}
func (s *translation) call(ctx context.Context, u update) error {
	previous := s.calls[u.ToolCallID]
	if u.Kind == "" {
		u.Kind = previous.Kind
	}
	if u.Name == "" {
		u.Name = previous.Name
	}
	if u.Title == "" {
		u.Title = previous.Title
	}
	if len(u.RawInput) == 0 {
		u.RawInput = previous.RawInput
	}
	s.calls[u.ToolCallID] = u
	if previous.ToolCallID != "" {
		return nil
	}
	name := u.Name
	if name == "" {
		name = u.Kind
	}
	if name == "" {
		name = "external_tool"
	}
	input := u.RawInput
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	return s.journal.Call(ctx, model.ToolCall{ID: u.ToolCallID, Name: name, Input: input})
}
func (s *translation) apply(ctx context.Context, u update) error {
	switch u.SessionUpdate {
	case "agent_message_chunk", "agent_thought_chunk":
		var content struct{ Type, Text string }
		if err := json.Unmarshal(u.Content, &content); err != nil {
			return err
		}
		if content.Type != "text" {
			break
		}
		chunk := model.Chunk{Kind: model.Text, Text: content.Text}
		if u.SessionUpdate == "agent_thought_chunk" {
			reason := &model.Reasoning{Text: content.Text, Provider: "acp"}
			s.parts = append(s.parts, model.Part{Reasoning: reason})
			chunk = model.Chunk{Kind: model.ReasoningChunk, Reasoning: reason}
		} else {
			if n := len(s.parts); n > 0 && s.parts[n-1].Reasoning == nil {
				s.parts[n-1].Text += content.Text
			} else {
				s.parts = append(s.parts, model.Part{Text: content.Text})
			}
		}
		return s.journal.Delta(ctx, chunk)
	case "tool_call", "tool_call_update":
		if err := s.flush(ctx); err != nil {
			return err
		}
		if err := s.call(ctx, u); err != nil {
			return err
		}
		if u.Status != "completed" && u.Status != "failed" {
			return nil
		}
		var content []struct {
			Type    string
			Content struct{ Type, Text string }
		}
		_ = json.Unmarshal(u.Content, &content)
		var parts []model.Part
		for _, item := range content {
			if item.Content.Type == "text" {
				parts = append(parts, model.Part{Text: item.Content.Text})
			}
		}
		if len(parts) == 0 && len(u.RawOutput) > 0 {
			parts = append(parts, model.Part{Text: string(u.RawOutput)})
		}
		return s.journal.Complete(ctx, u.ToolCallID, tool.Result{Parts: parts, IsError: u.Status == "failed"})
	case "user_message_chunk":
		return nil
	}
	raw, _ := json.Marshal(u)
	_, err := s.journal.Emit(ctx, tool.Progressed, tool.Progress{Raw: raw}, "")
	return err
}
func (s *translation) approve(ctx context.Context, gate *permission.Gate, params json.RawMessage) (any, error) {
	var request struct {
		ToolCall update
		Options  []struct{ OptionID, Kind string }
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, err
	}
	if err := s.call(ctx, request.ToolCall); err != nil {
		return nil, err
	}
	call := s.calls[request.ToolCall.ToolCallID]
	effect := tool.EffectExec
	if call.Kind == "read" || call.Kind == "search" {
		effect = tool.EffectRead
	}
	if call.Kind == "edit" || call.Kind == "delete" || call.Kind == "move" {
		effect = tool.EffectWrite
	}
	allowed, err := s.journal.Approve(ctx, gate, call.ToolCallID, "acp."+call.Kind, effect, params)
	if err != nil {
		return nil, err
	}
	kind := "reject_once"
	if allowed {
		kind = "allow_once"
	}
	outcome := map[string]string{"outcome": "cancelled"}
	for _, option := range request.Options {
		if option.Kind == kind {
			outcome = map[string]string{"outcome": "selected", "optionId": option.OptionID}
			break
		}
	}
	return map[string]any{"outcome": outcome}, nil
}
