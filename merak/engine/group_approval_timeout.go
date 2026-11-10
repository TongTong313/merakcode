package engine

import (
	"context"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type taskApproval struct {
	kind   string
	cancel context.CancelFunc
}

func (e *Engine) recoverTaskApprovals(ctx context.Context, groupID event.ID) error {
	facts, err := e.store.Read(ctx, event.Stream("group:"+groupID), 1, 0)
	if err != nil {
		return err
	}
	type waiting struct {
		kind string
		fact event.Event
	}
	pending := make(map[event.ID]waiting)
	for _, fact := range facts {
		switch fact.Type {
		case task.Created, task.Opened, task.QueuedEvent, task.Started, task.Reported, task.Updated, task.Reviewed, task.Closed, task.PhaseChanged:
		default:
			continue
		}
		card, err := event.Decode[task.Card](fact)
		if err != nil {
			return err
		}
		kind := ""
		if card.Status != task.Blocked && card.Status != task.Cancelled && card.Status != task.Done && card.Status != task.Failed {
			if card.PlanPending {
				kind = "plan"
			} else if card.Phase == task.PhaseReview || card.Status == task.Review && card.Review {
				kind = "review"
			}
		}
		if kind == "" {
			delete(pending, card.ID)
		} else if pending[card.ID].kind != kind {
			pending[card.ID] = waiting{kind: kind, fact: fact}
		}
	}
	for _, request := range pending {
		e.watchTaskApproval(request.fact, request.kind)
	}
	return nil
}

func (e *Engine) watchTaskApproval(fact event.Event, kind string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return
	}
	if previous := e.taskApprovals[fact.Scope.Task]; previous != nil {
		if previous.kind == kind {
			return
		}
		previous.cancel()
	}
	ctx, cancel := context.WithCancel(e.ctx)
	pending := &taskApproval{kind: kind, cancel: cancel}
	e.taskApprovals[fact.Scope.Task] = pending
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: fact.Scope.Group, Task: fact.Scope.Task}, Types: []event.Type{task.Updated, task.Reviewed, task.Closed, task.PhaseChanged}})
	timeout := e.permissions.Timeout
	if state, err := e.Groups.Get(ctx, fact.Scope.Group); err == nil {
		timeout = state.Group.Settings.ApprovalWait(timeout)
	}
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	delay := max(0, timeout-e.now().Sub(fact.Time))
	e.workers.Go(func() {
		defer cancel()
		defer stop()
		defer func() {
			e.mu.Lock()
			if e.taskApprovals[fact.Scope.Task] == pending {
				delete(e.taskApprovals, fact.Scope.Task)
			}
			e.mu.Unlock()
		}()
		timer := time.NewTimer(delay)
		defer timer.Stop()
		waiting := func() bool {
			card, err := e.Tasks.Get(ctx, fact.Scope.Task)
			if err != nil || card.Status == task.Blocked || card.Status == task.Done || card.Status == task.Cancelled || card.Status == task.Failed {
				return false
			}
			if kind == "plan" {
				return card.PlanPending
			}
			return card.Phase == task.PhaseReview || card.Status == task.Review
		}
		for waiting() {
			select {
			case _, ok := <-facts:
				if !ok {
					return
				}
			case <-ctx.Done():
				return
			case <-timer.C:
				if !waiting() {
					return
				}
				e.approvalTimedOut(ctx, fact.Scope, fact.Actor.ID, fact.ID)
				return
			}
		}
	})
}
