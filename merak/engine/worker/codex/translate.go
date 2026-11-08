package codex

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
)

func (r *Runner) approve(ctx context.Context, j *stdio.Journal, m wire) (any, error) {
	effect := tool.EffectExec
	name := "codex.command"
	switch m.Method {
	case "item/commandExecution/requestApproval":
	case "item/fileChange/requestApproval":
		effect, name = tool.EffectWrite, "codex.file_change"
	default:
		return nil, errors.New("unsupported codex server request")
	}
	var params struct{ ItemID string }
	if err := json.Unmarshal(m.Params, &params); err != nil {
		return nil, err
	}
	allowed, err := j.Approve(ctx, r.Gate, params.ItemID, name, effect, m.Params)
	decision := "decline"
	if allowed {
		decision = "accept"
	}
	return map[string]string{"decision": decision}, err
}
func translate(ctx context.Context, j *stdio.Journal, method string, params json.RawMessage) error {
	var raw struct {
		Delta string
		Item  struct {
			ID, Type, Text, Command, Status, AggregatedOutput, Server, Tool string
			Arguments                                                       json.RawMessage
			ExitCode                                                        *int
			Summary, Content                                                []string
		}
	}
	if err := json.Unmarshal(params, &raw); err != nil {
		return err
	}
	switch method {
	case "thread/started", "turn/started", "serverRequest/resolved":
		return nil
	case "item/agentMessage/delta":
		return j.Delta(ctx, model.Chunk{Kind: model.Text, Text: raw.Delta})
	case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
		return j.Delta(ctx, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Text: raw.Delta, Provider: "codex"}})
	case "item/started", "item/completed":
		item := raw.Item
		switch item.Type {
		case "agentMessage":
			if method == "item/completed" {
				return j.Message(ctx, session.Completion{Message: model.Message{Role: model.Assistant, Parts: []model.Part{{Text: item.Text}}}})
			}
			return nil
		case "userMessage":
			return nil
		case "reasoning":
			if method != "item/completed" {
				return nil
			}
			var parts []model.Part
			for _, text := range append(item.Summary, item.Content...) {
				parts = append(parts, model.Part{Reasoning: &model.Reasoning{Text: text, Provider: "codex"}})
			}
			return j.Message(ctx, session.Completion{Message: model.Message{Role: model.Assistant, Parts: parts}})
		case "commandExecution", "fileChange", "mcpToolCall":
			if method == "item/started" {
				input := params
				name := item.Type
				if item.Type == "commandExecution" {
					name = "bash"
					input, _ = json.Marshal(map[string]string{"command": item.Command})
				}
				if item.Type == "mcpToolCall" {
					name = item.Server + "." + item.Tool
					input = item.Arguments
				}
				return j.Call(ctx, model.ToolCall{ID: item.ID, Name: name, Input: input})
			}
			return j.Complete(ctx, item.ID, tool.Result{Parts: []model.Part{{Text: item.AggregatedOutput}}, ExitCode: item.ExitCode, IsError: item.Status != "completed"})
		}
	}
	_, err := j.Emit(ctx, tool.Progressed, tool.Progress{Raw: params}, "")
	return err
}
