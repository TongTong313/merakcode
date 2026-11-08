package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func (e *Engine) SayGroup(ctx context.Context, groupID, taskID, human event.ID, message group.Message) (event.ID, error) {
	member, err := e.groupMember(ctx, groupID, human)
	if err != nil {
		return "", err
	}
	if member.Kind != group.MemberHuman || strings.TrimSpace(message.Text) == "" {
		return "", errors.New("a human member and message text are required")
	}
	if taskID != "" {
		card, err := e.Tasks.Get(ctx, taskID)
		if err != nil {
			return "", err
		}
		if card.Group != groupID {
			return "", errors.New("task is outside this group")
		}
	}
	for _, id := range message.To {
		if _, err := e.groupMember(ctx, groupID, id); err != nil {
			return "", err
		}
	}
	body, _ := json.Marshal(message)
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID, Task: taskID}, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Type: group.HumanSaid, Payload: body})
	if err != nil {
		return "", err
	}
	body, _ = json.Marshal(group.Notice{Kind: "receipt", To: []event.ID{human}})
	_, err = e.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: event.Actor{Kind: event.ActorAgent}, Type: group.NoticeSent, Cause: fact.ID, Payload: body})
	return fact.ID, err
}

func (e *Engine) sayTool(g *groupRun, thread *leader.Thread, finish func(string)) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "say", Description: "Reply to the human in this group thread and end the current turn.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string","minLength":1}},"required":["text"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Text string `json:"text"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.Text) == "" {
			return nil, errors.New("message text is required")
		}
		body, _ := json.Marshal(session.Completion{Message: model.Message{Role: model.Assistant, Parts: []model.Part{{Text: input.Text}}}})
		scope := thread.Session.Scope
		scope.Session = thread.Session.ID
		fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Type: session.MessageCompleted, Payload: body})
		if err == nil {
			finish(input.Text)
		}
		return fact.ID, err
	}}
}
