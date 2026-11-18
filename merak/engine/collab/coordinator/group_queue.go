package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) withdrawClaimTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "withdraw_claim", Description: "Withdraw a queued claim from a task you lead. Active claims cannot be withdrawn.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"claim":{"type":"string"}},"required":["task","claim"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID `json:"task"`
			Claim event.ID `json:"claim"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		card, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		if !slices.ContainsFunc(card.Claims, func(c task.Claim) bool { return c.ID == input.Claim }) {
			return nil, errors.New("claim does not belong to this task")
		}
		return input.Claim, domain.tasks.Withdraw(ctx, input.Claim, thread.Leader)
	}}
}

func (domain *Coordinator) setTaskPriorityTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "set_task_priority", Description: "Set a task's queue priority. Higher values run first; equal values retain assignment order.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"priority":{"type":"integer"}},"required":["task","priority"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task     event.ID `json:"task"`
			Priority *int     `json:"priority"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Priority == nil {
			return nil, errors.New("priority is required")
		}
		if _, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Task); err != nil {
			return nil, err
		}
		return input.Task, domain.tasks.SetPriority(ctx, input.Task, thread.Leader, *input.Priority)
	}}
}

func (domain *Coordinator) AssignTask(ctx context.Context, id, human, member event.ID, role task.ClaimRole, scope []string) (task.Claim, error) {
	card, err := domain.tasks.Get(ctx, id)
	if err != nil {
		return task.Claim{}, err
	}
	actor, err := domain.roster.GroupMember(ctx, card.Group, human)
	if err != nil {
		return task.Claim{}, err
	}
	if !actor.Can(group.RoleMember) {
		return task.Claim{}, errorcode.Coded(errorcode.GroupRequestFailed, errors.New("human membership is required"))
	}
	if role == "" {
		role = task.RoleOwner
	}
	return domain.tasks.AssignAs(ctx, id, member, role, scope, event.Actor{Kind: event.ActorHuman, ID: human})
}
