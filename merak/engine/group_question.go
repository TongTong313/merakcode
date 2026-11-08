package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type pendingWorkerQuestion struct {
	group, task, member event.ID
	reply               chan string
	answered            bool
}

func (e *Engine) askLeaderTool(a worker.Assignment) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "ask_leader", Description: "Ask the Leader of this task one question and wait for its answer.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Text string `json:"text"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.Text) == "" {
			return nil, errors.New("question text is required")
		}
		body, _ := json.Marshal(group.MemberQuestion{Claim: a.Claim.ID, Text: input.Text})
		pending := &pendingWorkerQuestion{group: a.Scope.Group, task: a.Scope.Task, member: a.Claim.Member, reply: make(chan string, 1)}
		e.mu.Lock()
		fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Type: group.MemberAsked, Payload: body})
		if err == nil {
			e.workerQuestions[fact.ID] = pending
		}
		e.mu.Unlock()
		if err != nil {
			return nil, err
		}
		defer func() { e.mu.Lock(); delete(e.workerQuestions, fact.ID); e.mu.Unlock() }()
		select {
		case answer := <-pending.reply:
			return answer, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
}

func (e *Engine) askHumanTool(g *groupRun, thread *leader.Thread, finish func(string)) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "ask_human", Description: "Ask a human one question with optional suggested answers or a named recipient (to), then end this turn. The answer arrives as a question.answered event in this thread.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"},"to":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"required":["text"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var request question.Request
		if err := decodeGroupInput(call.Input, &request); err != nil {
			return nil, err
		}
		if strings.TrimSpace(request.Text) == "" || e.askQuestion == nil {
			return nil, errors.New("question text and a human question handler are required")
		}
		body, _ := json.Marshal(request)
		scope := thread.Session.Scope
		scope.Session = thread.Session.ID
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.ctx.Err() != nil {
			return nil, e.ctx.Err()
		}
		fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: scope, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Type: question.Asked, Payload: body})
		if err != nil {
			return nil, err
		}
		request.ID = fact.ID
		e.workers.Go(func() {
			answer, err := e.askQuestion(e.ctx, request)
			if err != nil {
				answer = question.Answer{Cancelled: true}
			}
			body, _ := json.Marshal(answer)
			_, _ = e.Bus.Publish(e.ctx, event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: event.Actor{Kind: event.ActorHuman, ID: answer.Human}, Type: question.Answered, Cause: fact.ID, Payload: body})
		})
		finish("Question sent. Waiting for the human's answer.")
		return fact.ID, nil
	}}
}

func (e *Engine) messageMemberTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "message_member", Description: "Message an active worker in this task thread. Include question with the member.asked event ID to answer a waiting question. Products without live input require a new task.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"member":{"type":"string"},"text":{"type":"string"},"question":{"type":"string"}},"required":["member","text"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Member   event.ID `json:"member"`
			Text     string   `json:"text"`
			Question event.ID `json:"question"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if strings.TrimSpace(input.Text) == "" || input.Member == "" {
			return nil, errors.New("member and message text are required")
		}
		if input.Question != "" {
			e.mu.Lock()
			defer e.mu.Unlock()
			pending := e.workerQuestions[input.Question]
			if pending == nil || pending.answered || pending.group != g.group.ID || pending.member != input.Member {
				return nil, errors.New("question is not waiting for this member")
			}
			if _, err := e.scopedTask(ctx, g.group.ID, thread, pending.task); err != nil {
				return nil, err
			}
			body, _ := json.Marshal(group.MemberAnswer{Member: input.Member, Text: input.Text})
			_, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: event.Scope{Group: g.group.ID, Task: pending.task}, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Type: group.MemberAnswered, Cause: input.Question, Payload: body})
			if err != nil {
				return nil, err
			}
			pending.answered = true
			pending.reply <- input.Text
			return input.Question, nil
		}
		cards, err := e.Tasks.List(ctx, g.group.ID)
		if err != nil {
			return nil, err
		}
		for _, card := range cards {
			if _, err := e.scopedTask(ctx, g.group.ID, thread, card.ID); err != nil {
				continue
			}
			for _, claim := range card.Claims {
				if claim.Member != input.Member || claim.Status != task.ClaimActive {
					continue
				}
				e.mu.Lock()
				active, ok := e.claimRuns[claim.ID]
				e.mu.Unlock()
				if !ok || !active.caps.Steer {
					return nil, errors.New("member does not accept live input; assign a new task")
				}
				return claim.ID, active.run.Send(ctx, loop.Input{Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Parts: []model.Part{{Text: input.Text}}})
			}
		}
		return nil, errors.New("member has no active claim in this thread")
	}}
}
