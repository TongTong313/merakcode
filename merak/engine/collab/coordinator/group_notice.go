package coordinator

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) notifyTask(ctx context.Context, fact event.Event) error {
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
		if previous, err := domain.core.Store.Get(ctx, fact.Cause); err == nil {
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
	state, err := domain.groups.Get(ctx, card.Group)
	if err != nil {
		return err
	}
	if fact.Type == task.PhaseChanged && kind == "review" && !card.Review && !state.Group.Settings.ReviewRequired() {
		return nil
	}
	var to []event.ID
	if kind == "review" || kind == "plan" {
		to = approval.Recipients(state.Members, group.RoleApprover, card.Participants)
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
	_, err = domain.core.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Type: group.NoticeSent, Actor: domain.roster.LeaderActor(ctx, card), Cause: fact.ID, Payload: body})
	if err == nil && (kind == "review" || kind == "plan") {
		domain.watchTaskApproval(fact, kind)
	}
	return err
}

// AuthorizePermission checks the active route before the transport consumes an answer.
func (domain *Coordinator) AuthorizePermission(ctx context.Context, request, human event.ID) (event.ID, error) {
	return domain.permissions.AuthorizeHuman(ctx, request, human)
}
