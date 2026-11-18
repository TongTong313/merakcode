package execution

import (
	"context"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Execution) workerBudget(ctx context.Context, p definition.Agent, a worker.Assignment, initial resolvedExecutionBudget, initialErr error) (context.Context, func()) {
	if p.Product == nil || p.Product.Kind == definition.KindBuiltin {
		return ctx, func() {}
	}
	ctx, cancel := context.WithCancelCause(ctx)
	var deadline <-chan time.Time
	var timer *time.Timer
	var expires time.Time
	err := initialErr
	if err == nil {
		_, expires, err = domain.checkExecutionBudget(ctx, a.Scope, a.Claim.Member, initial)
	}
	if err != nil {
		cancel(err)
	}
	if !expires.IsZero() {
		timer = time.NewTimer(max(0, expires.Sub(domain.core.Now())))
		deadline = timer.C
	}
	watch := event.Scope{Session: a.Session}
	if a.Scope.Task != "" {
		watch = event.Scope{Group: a.Scope.Group, Task: a.Scope.Task}
	}
	facts, stop := domain.core.Bus.Subscribe(event.Filter{Scope: watch, Types: []event.Type{loop.TurnStarted, session.MessageCompleted, session.Rebuilt}})
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer stop()
		steps := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-deadline:
				limit, expires, err := domain.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
				if err != nil {
					cancel(err)
					return
				}
				if limit == "" && expires.After(domain.core.Now()) {
					timer.Reset(expires.Sub(domain.core.Now()))
					continue
				}
				if limit == "" {
					limit = loop.MaxWallClock
				}
				cancel(worker.BudgetExceeded{Limit: limit})
				domain.BlockBudgetTask(context.WithoutCancel(ctx), a.Scope)
				return
			case fact, ok := <-facts:
				if !ok {
					return
				}
				if fact.Scope.Session == a.Session {
					if fact.Type == loop.TurnStarted {
						steps = 0
					}
					if fact.Type == session.MessageCompleted {
						completion, _ := event.Decode[session.Completion](fact)
						if completion.Step == nil || *completion.Step {
							steps++
						}
					}
				}
				limit, _, err := domain.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
				if err != nil {
					cancel(err)
					return
				}
				if p.Budget.MaxSteps > 0 && steps >= p.Budget.MaxSteps {
					limit = loop.MaxSteps
				}
				if limit != "" {
					cancel(worker.BudgetExceeded{Limit: limit})
					domain.BlockBudgetTask(context.WithoutCancel(ctx), a.Scope)
					return
				}
			}
		}
	}()
	return ctx, func() {
		cancel(nil)
		if timer != nil {
			timer.Stop()
		}
		<-done
	}
}
