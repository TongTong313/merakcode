package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/question"
)

func (e *Engine) routeQuestion(ask func(context.Context, question.Request) (question.Answer, error)) func(context.Context, question.Request) (question.Answer, error) {
	return func(ctx context.Context, req question.Request) (question.Answer, error) {
		fact, err := e.store.Get(ctx, req.ID)
		if err != nil {
			return question.Answer{}, err
		}
		if fact.Scope.Group == "" {
			if ask == nil {
				return question.Answer{Cancelled: true}, nil
			}
			return ask(ctx, req)
		}
		state, err := e.Groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return question.Answer{}, err
		}
		var to []event.ID
		for _, member := range state.Members {
			if member.Kind == group.MemberHuman && (req.To == member.ID || req.To == "" && member.Can(group.RoleApprover)) {
				to = append(to, member.ID)
			}
		}
		if req.To != "" && len(to) == 0 {
			return question.Answer{}, errors.New("question recipient must be a human in this group")
		}
		body, _ := json.Marshal(group.Notice{Kind: "question", Text: req.Text, To: to})
		_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + fact.Scope.Group), Scope: fact.Scope, Type: group.NoticeSent, Actor: fact.Actor, Cause: fact.ID, Payload: body})
		if err != nil {
			return question.Answer{}, err
		}
		answer := question.Answer{Cancelled: true}
		if ask != nil {
			answer, err = ask(ctx, req)
			if err == nil {
				answer.Human, err = e.AuthorizeQuestion(ctx, req.ID, answer.Human)
			}
			if err != nil {
				answer = question.Answer{Cancelled: true}
			}
		}
		if fact.Stream != event.Stream("group:"+fact.Scope.Group) {
			body, _ = json.Marshal(answer)
			_, publishErr := e.Bus.Publish(context.WithoutCancel(ctx), event.Event{Stream: event.Stream("group:" + fact.Scope.Group), Scope: fact.Scope, Type: question.Answered, Actor: event.Actor{Kind: event.ActorHuman, ID: answer.Human}, Cause: fact.ID, Payload: body})
			if err == nil {
				err = publishErr
			}
		}
		return answer, err
	}
}

// AuthorizeQuestion keeps a rejected reply from consuming a pending question.
func (e *Engine) AuthorizeQuestion(ctx context.Context, request, human event.ID) (event.ID, error) {
	fact, err := e.store.Get(ctx, request)
	if err != nil {
		return "", err
	}
	if fact.Type != question.Asked {
		return "", errors.New("event is not a question")
	}
	if fact.Scope.Group == "" {
		return human, nil
	}
	req, err := event.Decode[question.Request](fact)
	if err != nil {
		return "", err
	}
	state, err := e.Groups.Get(ctx, fact.Scope.Group)
	if err != nil {
		return "", err
	}
	var people []group.Member
	var named group.Member
	for _, member := range state.Members {
		if member.Kind == group.MemberHuman {
			people = append(people, member)
			if member.ID == req.To {
				named = member
			}
		}
	}
	if human == "" && len(people) == 1 {
		human = people[0].ID
	}
	for _, member := range people {
		if member.ID != human {
			continue
		}
		if req.To == "" && member.Can(group.RoleApprover) || req.To == human || named.ID != "" && member.Can(group.RoleAdmin) && !named.Can(member.Role) {
			return human, nil
		}
	}
	return "", errors.New("human cannot answer this question")
}
