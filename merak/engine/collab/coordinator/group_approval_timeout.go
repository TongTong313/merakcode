package coordinator

import (
	"context"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type taskApproval struct {
	kind   string
	cancel context.CancelFunc
}

func (domain *Coordinator) RecoverTaskApprovals(ctx context.Context, groupID event.ID) error {
	facts, err := domain.core.Store.Read(ctx, event.Stream("group:"+groupID), 1, 0)
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
		domain.watchTaskApproval(request.fact, request.kind)
	}
	return nil
}

func (domain *Coordinator) watchTaskApproval(fact event.Event, kind string) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return
	}
	if previous := domain.taskApprovals[fact.Scope.Task]; previous != nil {
		if previous.kind == kind {
			return
		}
		previous.cancel()
	}
	ctx, cancel := context.WithCancel(domain.core.Ctx)
	pending := &taskApproval{kind: kind, cancel: cancel}
	domain.taskApprovals[fact.Scope.Task] = pending
	facts, stop := domain.core.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: fact.Scope.Group, Task: fact.Scope.Task}, Types: []event.Type{task.Updated, task.Reviewed, task.Closed, task.PhaseChanged}})
	timeout := domain.permissions.Timeout
	if state, err := domain.groups.Get(ctx, fact.Scope.Group); err == nil {
		timeout = state.Group.Settings.ApprovalWait(timeout)
	}
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	delay := max(0, timeout-domain.core.Now().Sub(fact.Time))
	domain.core.Workers.Go(func() {
		defer cancel()
		defer stop()
		defer func() {
			domain.mu.Lock()
			if domain.taskApprovals[fact.Scope.Task] == pending {
				delete(domain.taskApprovals, fact.Scope.Task)
			}
			domain.mu.Unlock()
		}()
		timer := time.NewTimer(delay)
		defer timer.Stop()
		waiting := func() bool {
			card, err := domain.tasks.Get(ctx, fact.Scope.Task)
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
				domain.ApprovalTimedOut(ctx, fact.Scope, fact.Actor.ID, fact.ID)
				return
			}
		}
	})
}
