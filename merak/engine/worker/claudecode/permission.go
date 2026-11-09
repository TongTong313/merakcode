package claudecode

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
)

type controlRequest struct {
	Subtype   string          `json:"subtype"`
	ToolName  string          `json:"tool_name"`
	ToolUseID string          `json:"tool_use_id"`
	Input     json.RawMessage `json:"input"`
}

func (r *Runner) respondPermission(ctx context.Context, journal *stdio.Journal, id string, request controlRequest, write func(any) error) error {
	response := map[string]any{"subtype": "success", "request_id": id}
	if request.Subtype != "can_use_tool" || id == "" || request.ToolName == "" {
		response["subtype"], response["error"] = "error", "Unsupported control request."
		return write(map[string]any{"type": "control_response", "response": response})
	}
	effect := tool.EffectExec
	switch request.ToolName {
	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		effect = tool.EffectWrite
	case "Read", "Grep", "Glob":
		effect = tool.EffectRead
	case "WebFetch", "WebSearch":
		effect = tool.EffectNetwork
	}
	allowed, err := journal.Approve(ctx, r.Gate, request.ToolUseID, request.ToolName, effect, request.Input)
	if err != nil {
		return err
	}
	result := map[string]any{"behavior": "deny", "message": "Permission denied."}
	if allowed {
		result = map[string]any{"behavior": "allow", "updatedInput": request.Input}
	}
	response["response"] = result
	return write(map[string]any{"type": "control_response", "response": response})
}
