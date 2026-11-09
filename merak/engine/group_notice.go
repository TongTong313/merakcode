package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
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
	for _, member := range state.Members {
		if (kind == "review" || kind == "plan") && member.Can(group.RoleApprover) || kind == "info" && member.Kind == group.MemberHuman && member.ID == card.CreatedBy.ID || kind == "blocked" && member.Can(group.RoleOwner) {
			to = append(to, member.ID)
		}
	}
	if len(to) == 0 {
		return nil
	}
	body, _ := json.Marshal(group.Notice{Kind: kind, Text: card.Title, To: to})
	_, err = e.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent, ID: card.Leader}, Cause: fact.ID, Payload: body})
	return err
}

// AuthorizePermission checks the persisted request before the transport consumes an answer.
func (e *Engine) AuthorizePermission(ctx context.Context, request, human event.ID) (event.ID, error) {
	fact, err := e.store.Get(ctx, request)
	if err != nil {
		return "", err
	}
	if fact.Type != permission.Requested {
		return "", errors.New("event is not a permission request")
	}
	if fact.Scope.Group == "" {
		return human, nil
	}
	req, err := event.Decode[permission.Request](fact)
	if err != nil {
		return "", err
	}
	state, err := e.Groups.Get(ctx, fact.Scope.Group)
	if err != nil {
		return "", err
	}
	session, err := e.manager.Load(ctx, fact.Scope.Session)
	if err != nil {
		return "", err
	}
	role := permission.Need(req, workspace.Workspace{Directory: session.Config.Workdir}, state.Group)
	if human == "" {
		var humans []event.ID
		for _, member := range state.Members {
			if member.Kind == group.MemberHuman {
				humans = append(humans, member.ID)
			}
		}
		if len(humans) == 1 {
			human = humans[0]
		}
	}
	for _, member := range state.Members {
		if member.ID == human && member.Can(role) {
			return human, nil
		}
	}
	return "", errors.New("human does not have the required approval role")
}

func (e *Engine) routePermission(ask func(context.Context, permission.Request) (permission.Reply, error)) func(context.Context, permission.Request) (permission.Reply, error) {
	return func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		denied := permission.Reply{Decision: permission.Deny}
		if req.Call.Env.Scope.Group == "" {
			if ask == nil {
				return denied, nil
			}
			return ask(ctx, req)
		}
		state, err := e.Groups.Get(ctx, req.Call.Env.Scope.Group)
		if err != nil {
			return denied, err
		}
		role := permission.Need(req, workspace.Workspace{Directory: req.Call.Env.Workdir}, state.Group)
		var to []event.ID
		for _, member := range state.Members {
			if member.Can(role) {
				to = append(to, member.ID)
			}
		}
		scope := req.Call.Env.Scope
		body, _ := json.Marshal(group.Notice{Kind: "permission", To: to, Text: req.Spec.Name})
		_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + scope.Group), Scope: scope, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent}, Cause: req.ID, Payload: body})
		if err != nil {
			return denied, err
		}
		reply := denied
		if ask != nil {
			reply, err = ask(ctx, req)
			if err != nil {
				reply = denied
			}
		}
		if reply.Human == "" {
			var humans []group.Member
			for _, member := range state.Members {
				if member.Kind == group.MemberHuman {
					humans = append(humans, member)
				}
			}
			if len(humans) == 1 {
				reply.Human = humans[0].ID
			}
		}
		allowed := false
		for _, member := range state.Members {
			if member.ID == reply.Human && member.Can(role) {
				allowed = true
			}
		}
		if !allowed {
			reply.Decision = permission.Deny
			reply.Remember = ""
		}
		body, _ = json.Marshal(reply)
		_, publishErr := e.Bus.Publish(context.WithoutCancel(ctx), event.Event{Stream: event.Stream("group:" + scope.Group), Scope: scope, Type: permission.Replied, Actor: event.Actor{Kind: event.ActorHuman, ID: reply.Human}, Cause: req.ID, Payload: body})
		if err == nil {
			err = publishErr
		}
		return reply, err
	}
}
