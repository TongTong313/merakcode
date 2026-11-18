package execution

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Execution) UpdateTask(ctx context.Context, id event.ID, change task.Update, actor event.Actor) error {
	if change.Budget == nil {
		return domain.tasks.Update(ctx, id, change, actor)
	}
	if err := change.Budget.Validate(); err != nil {
		return err
	}
	if change.Phase != "" {
		return task.ErrState
	}
	card, err := domain.tasks.Get(ctx, id)
	if err != nil {
		return err
	}
	member, err := domain.roster.GroupMember(ctx, card.Group, actor.ID)
	if err != nil {
		return err
	}
	if actor.Kind == event.ActorHuman && member.Can(group.RoleOwner) {
		return domain.tasks.Update(ctx, id, change, actor)
	}
	if !(actor.Kind == event.ActorHuman && member.Can(group.RoleMember) || actor.Kind == event.ActorAgent && domain.roster.Leads(ctx, card, actor.ID)) {
		return task.ErrNotMember
	}
	if strings.TrimSpace(change.Reason) == "" {
		return errors.New("budget increase requires a reason")
	}
	used, _, err := domain.readBudgetUsage(ctx, event.Scope{Group: card.Group, Task: id}, "")
	if err != nil {
		return err
	}
	profiles := map[event.ID]session.Budget{}
	for _, claim := range card.Claims {
		member, err := domain.roster.GroupMember(ctx, card.Group, claim.Member)
		if err != nil {
			continue
		}
		p, err := domain.roster.MemberAgent(ctx, member)
		if err == nil {
			profiles[claim.Member] = grantedBudget(p.Budget, card.Grants)
		}
	}
	body, _ := json.Marshal(map[string]any{"task": id, "reason": change.Reason, "used": used, "taskBudget": grantedBudget(session.Budget(card.Budget), card.Grants), "memberBudgets": profiles, "grants": card.Grants, "increase": change.Budget})
	reply, err := domain.permissions.Ask(ctx, permission.Request{Kind: "budget", Member: actor.ID, Spec: tool.Spec{Name: "update_task", Effect: tool.EffectGroup}, Call: tool.Call{ID: string(domain.core.NewID()), Name: "update_task", Input: body, Env: tool.Env{Scope: event.Scope{Group: card.Group, Task: id}}}})
	if err != nil {
		return err
	}
	if reply.Decision != permission.Allow {
		return errors.New("MRK-5002")
	}
	return domain.tasks.Update(ctx, id, change, event.Actor{Kind: event.ActorHuman, ID: reply.Human})
}
