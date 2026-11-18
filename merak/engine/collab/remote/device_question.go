package remote

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type deviceAnswer struct {
	ready chan struct{}
	value question.Answer
	done  bool
}

// deviceQuestion retains a reply that arrives between publication and waiting.
// Callers hold cloudReplyMu.
func (domain *Remote) deviceQuestion(id event.ID) *deviceAnswer {
	answer := domain.cloudAnswers[id]
	if answer == nil {
		answer = &deviceAnswer{ready: make(chan struct{})}
		domain.cloudAnswers[id] = answer
	}
	return answer
}

func (domain *Remote) WaitDeviceQuestion(ctx context.Context, id event.ID) (question.Answer, error) {
	domain.cloudReplyMu.Lock()
	answer := domain.deviceQuestion(id)
	domain.cloudReplyMu.Unlock()
	defer func() {
		domain.cloudReplyMu.Lock()
		delete(domain.cloudAnswers, id)
		domain.cloudReplyMu.Unlock()
	}()
	select {
	case domain.cloudWake <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return question.Answer{Cancelled: true}, ctx.Err()
	case <-answer.ready:
		return answer.value, nil
	}
}

func (domain *Remote) answerDeviceQuestion(ctx context.Context, reply wire.DeviceAnswer) {
	fact, err := domain.core.Store.Get(ctx, reply.Request)
	if err != nil || (fact.Type != question.Asked && fact.Type != group.MemberAsked) || !domain.ActiveDeviceGroup(fact.Scope.Group) {
		return
	}
	domain.cloudMu.Lock()
	active := false
	for _, run := range domain.deviceRuns {
		if run.assignment.Session == fact.Scope.Session {
			active = true
			break
		}
	}
	domain.cloudMu.Unlock()
	if !active {
		return
	}
	domain.cloudReplyMu.Lock()
	defer domain.cloudReplyMu.Unlock()
	answer := domain.deviceQuestion(reply.Request)
	if !answer.done {
		answer.value = question.Answer{Human: reply.Human, Text: reply.Text, Cancelled: reply.Cancelled}
		answer.done = true
		close(answer.ready)
	}
}

func (r *Remote) PublishWorkerQuestion(ctx context.Context, fact event.Event) (event.Event, *PendingWorkerQuestion, error) {
	pending := &PendingWorkerQuestion{group: fact.Scope.Group, Task: fact.Scope.Task, member: fact.Actor.ID, Reply: make(chan string, 1)}
	r.mu.Lock()
	defer r.mu.Unlock()
	fact, err := r.core.Bus.Publish(ctx, fact)
	if err == nil {
		r.workerQuestions[fact.ID] = pending
	}
	return fact, pending, err
}

func (r *Remote) ForgetWorkerQuestion(id event.ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.workerQuestions, id)
}

func (r *Remote) WorkerQuestion(id, groupID, memberID event.ID) (*PendingWorkerQuestion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pending := r.workerQuestions[id]
	if pending == nil || pending.answered || pending.group != groupID || pending.member != memberID {
		return nil, errors.New("question is not waiting for this member")
	}
	return pending, nil
}

func (r *Remote) AnswerWorkerQuestion(ctx context.Context, id event.ID, pending *PendingWorkerQuestion, leaderID event.ID, text string) (event.ID, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if pending == nil || r.workerQuestions[id] != pending || pending.answered {
		return "", errors.New("question is not waiting for this member")
	}
	body, _ := json.Marshal(group.MemberAnswer{Member: pending.member, Text: text})
	_, err := r.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + pending.group), Scope: event.Scope{Group: pending.group, Task: pending.Task}, Actor: event.Actor{Kind: event.ActorAgent, ID: leaderID}, Type: group.MemberAnswered, Cause: id, Payload: body})
	if err != nil {
		return "", err
	}
	pending.answered = true
	pending.Reply <- text
	return id, nil
}
