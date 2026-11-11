package engine

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func (e *Engine) notifyTask(ctx context.Context, fact event.Event) error {
	if fact.Type != task.Reported && fact.Type != task.Closed && fact.Type != task.Updated && fact.Type != task.PhaseChanged {
		return nil
	}
	card, err := event.Decode[task.Card](fact)
	if err != nil {
		return err
	}
	kind := ""
	if fact.Type == task.PhaseChanged && card.Phase == task.PhaseReview {
		kind = "review"
	}
	if fact.Type == task.PhaseChanged && card.Phase == task.PhaseStalled {
		kind = "blocked"
	}
	if fact.Type == task.Updated && card.PlanPending {
		kind = "plan"
		if previous, err := e.store.Get(ctx, fact.Cause); err == nil {
			old, _ := event.Decode[task.Card](previous)
			if old.PlanPending {
				return nil
			}
		}
	}
	if fact.Type == task.Reported && card.Status == task.Review && card.Review {
		kind = "review"
	}
	if fact.Type == task.Closed {
		kind = "info"
	}
	if kind == "" {
		return nil
	}
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		return err
	}
	if fact.Type == task.PhaseChanged && kind == "review" && !card.Review && !state.Group.Settings.ReviewRequired() {
		return nil
	}
	var to []event.ID
	if kind == "review" || kind == "plan" {
		to = permission.Recipients(state.Members, group.RoleApprover, card.Participants)
	}
	for _, member := range state.Members {
		if kind == "info" && member.Kind == group.MemberHuman && member.ID == card.CreatedBy.ID || kind == "blocked" && member.Can(group.RoleOwner) {
			to = append(to, member.ID)
		}
	}
	if len(to) == 0 {
		return nil
	}
	body, _ := json.Marshal(group.Notice{Kind: kind, Text: card.Title, To: to})
	_, err = e.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Type: group.NoticeSent, Actor: e.leaderActor(ctx, card), Cause: fact.ID, Payload: body})
	if err == nil && (kind == "review" || kind == "plan") {
		e.watchTaskApproval(fact, kind)
	}
	return err
}

// AuthorizePermission checks the active route before the transport consumes an answer.
func (e *Engine) AuthorizePermission(ctx context.Context, request, human event.ID) (event.ID, error) {
	return e.permissions.AuthorizeHuman(ctx, request, human)
}
