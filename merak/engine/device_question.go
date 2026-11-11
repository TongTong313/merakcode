package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type deviceAnswer struct {
	ready chan struct{}
	value question.Answer
	done  bool
}

// deviceQuestion retains a reply that arrives between publication and waiting.
// Callers hold cloudReplyMu.
func (e *Engine) deviceQuestion(id event.ID) *deviceAnswer {
	answer := e.cloudAnswers[id]
	if answer == nil {
		answer = &deviceAnswer{ready: make(chan struct{})}
		e.cloudAnswers[id] = answer
	}
	return answer
}

func (e *Engine) waitDeviceQuestion(ctx context.Context, id event.ID) (question.Answer, error) {
	e.cloudReplyMu.Lock()
	answer := e.deviceQuestion(id)
	e.cloudReplyMu.Unlock()
	defer func() { e.cloudReplyMu.Lock(); delete(e.cloudAnswers, id); e.cloudReplyMu.Unlock() }()
	select {
	case e.cloudWake <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return question.Answer{Cancelled: true}, ctx.Err()
	case <-answer.ready:
		return answer.value, nil
	}
}

func (e *Engine) answerDeviceQuestion(ctx context.Context, reply protocol.DeviceAnswer) {
	fact, err := e.store.Get(ctx, reply.Request)
	if err != nil || (fact.Type != question.Asked && fact.Type != group.MemberAsked) || !e.activeDeviceGroup(fact.Scope.Group) {
		return
	}
	e.cloudMu.Lock()
	active := false
	for _, run := range e.deviceRuns {
		if run.assignment.Session == fact.Scope.Session {
			active = true
			break
		}
	}
	e.cloudMu.Unlock()
	if !active {
		return
	}
	e.cloudReplyMu.Lock()
	defer e.cloudReplyMu.Unlock()
	answer := e.deviceQuestion(reply.Request)
	if !answer.done {
		answer.value = question.Answer{Human: reply.Human, Text: reply.Text, Cancelled: reply.Cancelled}
		answer.done = true
		close(answer.ready)
	}
}
