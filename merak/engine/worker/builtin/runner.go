// Package builtin runs background children through the same conversation loop as their parent.
package builtin

import (
	"context"
	"errors"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type Runner struct {
	bus      *event.Bus
	ctx      context.Context
	cancel   context.CancelFunc
	newID    func() event.ID
	run      func(context.Context, event.ID, string) (loop.Outcome, error)
	mu       sync.Mutex
	children map[event.ID]childRun
	pending  []loop.Input
	ready    chan struct{}
	workers  sync.WaitGroup
}

type childRun struct {
	done   chan struct{}
	cancel context.CancelFunc
}

func New(ctx context.Context, bus *event.Bus, newID func() event.ID, run func(context.Context, event.ID, string) (loop.Outcome, error)) *Runner {
	ctx, cancel := context.WithCancel(ctx)
	return &Runner{bus: bus, ctx: ctx, cancel: cancel, newID: newID, run: run, children: make(map[event.ID]childRun), ready: make(chan struct{}, 1)}
}

func (r *Runner) SetRun(run func(context.Context, event.ID, string) (loop.Outcome, error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.run = run
}

func (r *Runner) Spawn(ctx context.Context, prompt string) (event.ID, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ctx.Err(); err != nil {
		return "", err
	}
	id := r.newID()
	done := make(chan struct{})
	childCtx, cancel := context.WithCancel(r.ctx)
	execute := r.run
	var outcome loop.Outcome
	adapter := &Adapter{Bus: r.bus, Execute: func(ctx context.Context, a worker.Assignment, _ loop.Steer) (loop.Outcome, error) {
		var err error
		outcome, err = execute(ctx, a.Session, a.Packet)
		return outcome, err
	}}
	run, err := adapter.Start(childCtx, worker.Assignment{Session: id, Packet: prompt})
	if err != nil {
		cancel()
		return "", err
	}
	r.children[id] = childRun{done: done, cancel: cancel}
	r.workers.Go(func() {
		defer cancel()
		_, err := run.Wait(context.Background())
		result := session.ChildResult{ID: id, Report: outcome.Final, Stop: string(outcome.Stop), Code: outcome.Code}
		if err != nil && result.Code == "" {
			result.Code = "MRK-5003"
			result.Stop = "failed"
		}
		if len(result.Report) == 0 {
			result.Report = []model.Part{{Text: "Child ended without a report."}}
		}
		r.mu.Lock()
		r.pending = append(r.pending, loop.Input{Actor: event.Actor{Kind: event.ActorAgent, ID: id}, Child: &result})
		r.mu.Unlock()
		close(done)
		select {
		case r.ready <- struct{}{}:
		default:
		}
	})
	return id, nil
}

func (r *Runner) Wait(ctx context.Context, id event.ID) error {
	r.mu.Lock()
	child, ok := r.children[id]
	r.mu.Unlock()
	if !ok {
		return errors.New("child is not owned by this session")
	}
	select {
	case <-child.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Runner) Poll() []loop.Input {
	r.mu.Lock()
	defer r.mu.Unlock()
	inputs := r.pending
	r.pending = nil
	select {
	case <-r.ready:
	default:
	}
	return inputs
}

func (r *Runner) Preempt() <-chan struct{} { return nil }
func (r *Runner) Ready() <-chan struct{}   { return r.ready }
func (r *Runner) Close()                   { r.mu.Lock(); r.cancel(); r.mu.Unlock(); r.workers.Wait() }

func (r *Runner) Cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, child := range r.children {
		child.cancel()
	}
}
