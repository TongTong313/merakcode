package builtin

import (
	"context"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type Adapter struct {
	Bus     *event.Bus
	Execute func(context.Context, worker.Assignment, loop.Steer) (loop.Outcome, error)
}

func (*Adapter) Caps() worker.Caps { return worker.Caps{Steer: true, Permission: true} }
func (r *Adapter) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	return worker.Launch(ctx, r.Bus, a, func(ctx context.Context, inputs <-chan loop.Input) (task.Report, error) {
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		steer := &steering{ctx: ctx, preempt: make(chan struct{}, 1), poll: make(chan chan []loop.Input)}
		done := make(chan struct{})
		go func() { defer close(done); steer.receive(ctx, inputs) }()
		defer func() { cancel(); <-done }()
		outcome, err := r.Execute(ctx, a, steer)
		var text strings.Builder
		for _, part := range outcome.Final {
			text.WriteString(part.Text)
		}
		report := worker.ReportFromText(a.Claim.ID, text.String(), outcome.Stop, err)
		report.Usage = outcome.Usage
		return report, err
	})
}

type steering struct {
	ctx     context.Context
	poll    chan chan []loop.Input
	preempt chan struct{}
}

func (s *steering) receive(ctx context.Context, inputs <-chan loop.Input) {
	var pending []loop.Input
	for {
		select {
		case <-ctx.Done():
			return
		case input, ok := <-inputs:
			if !ok {
				return
			}
			pending = append(pending, input)
			if input.Actor.Kind == event.ActorHuman {
				select {
				case s.preempt <- struct{}{}:
				default:
				}
			}
		case response := <-s.poll:
		drain:
			for {
				select {
				case input, ok := <-inputs:
					if !ok {
						break drain
					}
					pending = append(pending, input)
				default:
					break drain
				}
			}
			select {
			case <-s.preempt:
			default:
			}
			response <- pending
			pending = nil
		}
	}
}
func (s *steering) Poll() []loop.Input {
	response := make(chan []loop.Input, 1)
	select {
	case <-s.ctx.Done():
		return nil
	case s.poll <- response:
	}
	select {
	case <-s.ctx.Done():
		return nil
	case result := <-response:
		return result
	}
}
func (s *steering) Preempt() <-chan struct{} { return s.preempt }
