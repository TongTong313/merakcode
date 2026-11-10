package engine

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func (e *Engine) withdrawClaimTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "withdraw_claim", Description: "Withdraw a queued claim from a task you lead. Active claims cannot be withdrawn.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"claim":{"type":"string"}},"required":["task","claim"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID `json:"task"`
			Claim event.ID `json:"claim"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		card, err := e.scopedTask(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		if !slices.ContainsFunc(card.Claims, func(c task.Claim) bool { return c.ID == input.Claim }) {
			return nil, errors.New("claim does not belong to this task")
		}
		return input.Claim, e.Tasks.Withdraw(ctx, input.Claim, thread.Leader)
	}}
}

func (e *Engine) setTaskPriorityTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "set_task_priority", Description: "Set a task's queue priority. Higher values run first; equal values retain assignment order.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"priority":{"type":"integer"}},"required":["task","priority"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task     event.ID `json:"task"`
			Priority *int     `json:"priority"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Priority == nil {
			return nil, errors.New("priority is required")
		}
		if _, err := e.scopedTask(ctx, g.group.ID, thread, input.Task); err != nil {
			return nil, err
		}
		return input.Task, e.Tasks.SetPriority(ctx, input.Task, thread.Leader, *input.Priority)
	}}
}

func (e *Engine) AssignTask(ctx context.Context, id, human, member event.ID, role task.ClaimRole, scope []string) (task.Claim, error) {
	card, err := e.Tasks.Get(ctx, id)
	if err != nil {
		return task.Claim{}, err
	}
	actor, err := e.groupMember(ctx, card.Group, human)
	if err != nil {
		return task.Claim{}, err
	}
	if !actor.Can(group.RoleMember) {
		return task.Claim{}, errors.New("human membership is required")
	}
	if role == "" {
		role = task.RoleOwner
	}
	return e.Tasks.AssignAs(ctx, id, member, role, scope, event.Actor{Kind: event.ActorHuman, ID: human})
}
