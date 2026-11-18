package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) askLeaderTool(a worker.Assignment) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "ask_leader", Description: "Ask the Leader of this task one question and wait for its answer.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Text string `json:"text"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.Text) == "" {
			return nil, errors.New("question text is required")
		}
		body, _ := json.Marshal(group.MemberQuestion{Claim: a.Claim.ID, Text: input.Text})
		fact, pending, err := domain.remote.PublishWorkerQuestion(ctx, event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Type: group.MemberAsked, Payload: body})
		if err != nil {
			return nil, err
		}
		defer domain.remote.ForgetWorkerQuestion(fact.ID)
		if domain.remote.ActiveDeviceGroup(a.Scope.Group) {
			answer, err := domain.remote.WaitDeviceQuestion(ctx, fact.ID)
			if err == nil && answer.Cancelled {
				err = context.Canceled
			}
			if err == nil {
				body, _ := json.Marshal(group.MemberAnswer{Member: a.Claim.Member, Text: answer.Text})
				_, err = domain.core.Bus.Publish(ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: event.Actor{Kind: event.ActorExternal}, Type: group.MemberAnswered, Cause: fact.ID, Payload: body})
			}
			return answer.Text, err
		}
		state, err := domain.groups.Get(ctx, a.Scope.Group)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(ctx, max(0, state.Group.Settings.ApprovalWait(domain.permissions.Timeout)-domain.core.Now().Sub(fact.Time)))
		defer cancel()
		select {
		case answer := <-pending.Reply:
			return answer, nil
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				domain.ApprovalTimedOut(context.WithoutCancel(ctx), fact.Scope, fact.Actor.ID, fact.ID)
			}
			return nil, ctx.Err()
		}
	}}
}

func (domain *Coordinator) askHumanTool(g *groupRun, thread *leader.Thread, finish func(string)) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "ask_human", Description: "Ask a human one question, or escalate a permission request by providing its request ID. End this turn while waiting for the human. Options and to apply only to questions.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"request":{"type":"string"},"text":{"type":"string"},"to":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"anyOf":[{"required":["text"]},{"required":["request"]}],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Request event.ID `json:"request"`
			Text    string   `json:"text"`
			To      event.ID `json:"to"`
			Options []string `json:"options"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Request != "" {
			if err := domain.permissions.Escalate(ctx, input.Request, g.group.ID, thread.Key, thread.Leader); err != nil {
				return nil, err
			}
			finish("Permission request sent to a human.")
			return input.Request, nil
		}
		request := question.Request{Text: input.Text, To: input.To, Options: input.Options}
		if strings.TrimSpace(request.Text) == "" || domain.askQuestion == nil {
			return nil, errors.New("question text and a human question handler are required")
		}
		body, _ := json.Marshal(request)
		scope := thread.Session.Read().Scope
		scope.Session = thread.Session.Read().ID
		domain.mu.Lock()
		defer domain.mu.Unlock()
		if domain.core.Ctx.Err() != nil {
			return nil, domain.core.Ctx.Err()
		}
		fact, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Type: question.Asked, Payload: body})
		if err != nil {
			return nil, err
		}
		request.ID = fact.ID
		domain.core.Workers.Go(func() {
			answer, err := domain.askQuestion(domain.core.Ctx, request)
			if err != nil {
				answer = question.Answer{Cancelled: true}
			}
			body, _ := json.Marshal(answer)
			_, _ = domain.core.Bus.Publish(domain.core.Ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: event.Actor{Kind: event.ActorHuman, ID: answer.Human}, Type: question.Answered, Cause: fact.ID, Payload: body})
		})
		finish("Question sent. Waiting for the human's answer.")
		return fact.ID, nil
	}}
}

func (domain *Coordinator) messageMemberTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "message_member", Description: "Message an active worker in this task thread. Include question with the member.asked event ID to answer a waiting question. Products without live input require a new task.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"member":{"type":"string"},"text":{"type":"string"},"question":{"type":"string"}},"required":["member","text"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Member   event.ID `json:"member"`
			Text     string   `json:"text"`
			Question event.ID `json:"question"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.Text) == "" || input.Member == "" {
			return nil, errors.New("member and message text are required")
		}
		if input.Question != "" {
			pending, err := domain.remote.WorkerQuestion(input.Question, g.group.ID, input.Member)
			if err != nil {
				return nil, err
			}
			if _, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, pending.Task); err != nil {
				return nil, err
			}
			id, err := domain.remote.AnswerWorkerQuestion(ctx, input.Question, pending, thread.Leader, input.Text)
			if err != nil {
				return nil, err
			}
			return id, nil
		}
		cards, err := domain.tasks.List(ctx, g.group.ID)
		if err != nil {
			return nil, err
		}
		for _, card := range cards {
			if _, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, card.ID); err != nil {
				continue
			}
			for _, claim := range card.Claims {
				if claim.Member != input.Member || claim.Status != task.ClaimActive {
					continue
				}
				if !domain.sendClaimInput(ctx, g.group.ID, claim, loop.Input{Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Parts: []model.Part{{Text: input.Text}}}) {
					return nil, errors.New("member does not accept live input; assign a new task")
				}
				return claim.ID, nil
			}
		}
		return nil, errors.New("member has no active claim in this thread")
	}}
}
