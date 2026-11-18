package kit

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// ClaimTask lets a Worker take an open task of its own group.
type ClaimTask struct {
	Claim func(ctx context.Context, id event.ID, scope []string) (task.Claim, error)
}

func (ClaimTask) Spec() tool.Spec {
	return tool.Spec{Name: "claim_task", Description: "Claim an open task of your group for yourself. The first claim owns the task; join a task that already has an owner only with a scope of project-relative paths that no one else holds. If you are busy the claim waits in your queue.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"scope":{"type":"array","items":{"type":"string"}}},"required":["task"],"additionalProperties":false}`)}
}

func (t ClaimTask) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	var input struct {
		Task  event.ID `json:"task"`
		Scope []string `json:"scope"`
	}
	if err := tool.DecodeInput(call.Input, &input); err != nil {
		return tool.Failure(err), nil
	}
	if t.Claim == nil || input.Task == "" {
		return tool.Failure(errors.New("claiming requires a task id and an active member")), nil
	}
	claim, err := t.Claim(ctx, input.Task, input.Scope)
	if err != nil {
		return tool.Failure(err), nil
	}
	body, err := json.Marshal(claim)
	if err != nil {
		return tool.Result{}, err
	}
	return tool.Result{Parts: []model.Part{{Text: string(body)}}}, nil
}
