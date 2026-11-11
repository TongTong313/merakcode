package engine

import (
	"context"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func (e *Engine) workerBudget(ctx context.Context, p agent.Agent, a worker.Assignment) (context.Context, func()) {
	if p.Product == nil || p.Product.Kind == worker.KindBuiltin {
		return ctx, func() {}
	}
	ctx, cancel := context.WithCancelCause(ctx)
	var deadline <-chan time.Time
	var timer *time.Timer
	_, expires, err := e.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
	if err != nil {
		cancel(err)
	}
	if !expires.IsZero() {
		timer = time.NewTimer(max(0, expires.Sub(e.now())))
		deadline = timer.C
	}
	watch := event.Scope{Session: a.Session}
	if a.Scope.Task != "" {
		watch = event.Scope{Group: a.Scope.Group, Task: a.Scope.Task}
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: watch, Types: []event.Type{loop.TurnStarted, session.MessageCompleted, session.Rebuilt}})
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
				limit, expires, err := e.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
				if err != nil {
					cancel(err)
					return
				}
				if limit == "" && expires.After(e.now()) {
					timer.Reset(expires.Sub(e.now()))
					continue
				}
				if limit == "" {
					limit = loop.MaxWallClock
				}
				cancel(worker.BudgetExceeded{Limit: limit})
				e.blockBudgetTask(context.WithoutCancel(ctx), a.Scope)
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
				limit, _, err := e.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
				if err != nil {
					cancel(err)
					return
				}
				if p.Budget.MaxSteps > 0 && steps >= p.Budget.MaxSteps {
					limit = loop.MaxSteps
				}
				if limit != "" {
					cancel(worker.BudgetExceeded{Limit: limit})
					e.blockBudgetTask(context.WithoutCancel(ctx), a.Scope)
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
