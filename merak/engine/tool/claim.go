package tool

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

// ClaimTask lets a Worker take an open task of its own group.
type ClaimTask struct {
	Claim func(ctx context.Context, id event.ID, scope []string) (task.Claim, error)
}

func (ClaimTask) Spec() Spec {
	return Spec{Name: "claim_task", Description: "Claim an open task of your group for yourself. The first claim owns the task; join a task that already has an owner only with a scope of project-relative paths that no one else holds. If you are busy the claim waits in your queue.", Effect: EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"scope":{"type":"array","items":{"type":"string"}}},"required":["task"],"additionalProperties":false}`)}
}

func (t ClaimTask) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Task  event.ID `json:"task"`
		Scope []string `json:"scope"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if t.Claim == nil || input.Task == "" {
		return failure(errors.New("claiming requires a task id and an active member")), nil
	}
	claim, err := t.Claim(ctx, input.Task, input.Scope)
	if err != nil {
		return failure(err), nil
	}
	body, err := json.Marshal(claim)
	if err != nil {
		return Result{}, err
	}
	return Result{Parts: []model.Part{{Text: string(body)}}}, nil
}
