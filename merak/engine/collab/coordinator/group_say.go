package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) SayGroup(ctx context.Context, groupID, taskID, human event.ID, message group.Message) (event.ID, error) {
	state, err := domain.groups.Get(ctx, groupID)
	if err != nil {
		return "", err
	}
	if state.Group.Archived {
		return "", errorcode.Coded(errorcode.GroupArchived, errors.New("the group is archived and read-only"))
	}
	member, err := domain.roster.GroupMember(ctx, groupID, human)
	if err != nil {
		return "", err
	}
	if !member.Can(group.RoleMember) || strings.TrimSpace(message.Text) == "" {
		return "", errors.New("a human member and message text are required")
	}
	if taskID != "" {
		card, err := domain.tasks.Get(ctx, taskID)
		if err != nil {
			return "", err
		}
		if card.Group != groupID {
			return "", errors.New("task is outside this group")
		}
	}
	for _, id := range message.To {
		if _, err := domain.roster.GroupMember(ctx, groupID, id); err != nil {
			return "", err
		}
	}
	// A Leader that kept failing halted its group (MRK-4004); people have no control for it, so what they write wakes it.
	if len(state.PausedThreads) > 0 {
		wake, _ := json.Marshal(group.Control{})
		if _, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID}, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Type: group.Resumed, Payload: wake}); err != nil {
			return "", err
		}
	}
	body, _ := json.Marshal(message)
	fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID, Task: taskID}, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Type: group.HumanSaid, Payload: body})
	if err != nil {
		return "", err
	}
	body, _ = json.Marshal(group.Notice{Kind: "receipt", To: []event.ID{human}})
	_, err = domain.core.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: event.Actor{Kind: event.ActorAgent}, Type: group.NoticeSent, Cause: fact.ID, Payload: body})
	return fact.ID, err
}

func (domain *Coordinator) sayTool(g *groupRun, thread *leader.Thread, finish func(string)) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "say", Description: "Reply to the human in this group thread and end the current turn.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string","minLength":1}},"required":["text"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Text string `json:"text"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.Text) == "" {
			return nil, errors.New("message text is required")
		}
		body, _ := json.Marshal(session.Completion{Message: model.Message{Role: model.Assistant, Parts: []model.Part{{Text: input.Text}}}})
		scope := thread.Session.Read().Scope
		scope.Session = thread.Session.Read().ID
		fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Type: session.MessageCompleted, Payload: body})
		if err == nil {
			finish(input.Text)
		}
		return fact.ID, err
	}}
}
