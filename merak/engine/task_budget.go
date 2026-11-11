package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"strings"
)

func (e *Engine) UpdateTask(ctx context.Context, id event.ID, change task.Update, actor event.Actor) error {
	if change.Budget == nil {
		return e.Tasks.Update(ctx, id, change, actor)
	}
	if err := change.Budget.Validate(); err != nil {
		return err
	}
	if change.Phase != "" {
		return task.ErrState
	}
	card, err := e.Tasks.Get(ctx, id)
	if err != nil {
		return err
	}
	member, err := e.groupMember(ctx, card.Group, actor.ID)
	if err != nil {
		return err
	}
	if actor.Kind == event.ActorHuman && member.Can(group.RoleOwner) {
		return e.Tasks.Update(ctx, id, change, actor)
	}
	if !(actor.Kind == event.ActorHuman && member.Can(group.RoleMember) || actor.Kind == event.ActorAgent && e.leads(ctx, card, actor.ID)) {
		return task.ErrNotMember
	}
	if strings.TrimSpace(change.Reason) == "" {
		return errors.New("budget increase requires a reason")
	}
	used, _, err := e.readBudgetUsage(ctx, event.Scope{Group: card.Group, Task: id}, "")
	if err != nil {
		return err
	}
	profiles := map[event.ID]session.Budget{}
	for _, claim := range card.Claims {
		member, err := e.groupMember(ctx, card.Group, claim.Member)
		if err != nil {
			continue
		}
		p, err := e.memberAgent(ctx, member)
		if err == nil {
			profiles[claim.Member] = grantedBudget(p.Budget, card.Grants)
		}
	}
	body, _ := json.Marshal(map[string]any{"task": id, "reason": change.Reason, "used": used, "taskBudget": grantedBudget(session.Budget(card.Budget), card.Grants), "memberBudgets": profiles, "grants": card.Grants, "increase": change.Budget})
	reply, err := e.permissions.Ask(ctx, permission.Request{Kind: "budget", Member: actor.ID, Spec: tool.Spec{Name: "update_task", Effect: tool.EffectGroup}, Call: tool.Call{ID: string(e.newID()), Name: "update_task", Input: body, Env: tool.Env{Scope: event.Scope{Group: card.Group, Task: id}}}})
	if err != nil {
		return err
	}
	if reply.Decision != permission.Allow {
		return errors.New("MRK-5002")
	}
	return e.Tasks.Update(ctx, id, change, event.Actor{Kind: event.ActorHuman, ID: reply.Human})
}

func (e *Engine) updateTaskTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "update_task", Description: "Request an owner-approved budget increase for this task. Provide token, cost or wall-clock increments and a reason. Reassign the original member after approval to continue its session.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"reason":{"type":"string"},"budget":{"type":"object","properties":{"tokens":{"type":"integer","minimum":0},"cost":{"type":"number","minimum":0},"wallClock":{"type":"integer","minimum":0}},"additionalProperties":false}},"required":["task","reason","budget"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task event.ID `json:"task"`
			task.Update
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if _, err := e.scopedTask(ctx, g.group.ID, thread, input.Task); err != nil {
			return nil, err
		}
		if err := e.UpdateTask(ctx, input.Task, input.Update, event.Actor{Kind: event.ActorAgent, ID: thread.Leader}); err != nil {
			return nil, err
		}
		return e.Tasks.Get(ctx, input.Task)
	}}
}
