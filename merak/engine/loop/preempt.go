package loop

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

var errPreempted = errors.New("model step preempted by human input")

func (l *Loop) askStep(ctx context.Context, s *session.State, scope event.Scope, request model.Request) (session.Completion, error) {
	if l.Steer == nil || l.Steer.Preempt() == nil {
		return l.ask(ctx, s, scope, request)
	}
	step, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	finished, joined := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(joined)
		select {
		case <-finished:
		case <-step.Done():
		case <-l.Steer.Preempt():
			cancel(errPreempted)
		}
	}()
	message, err := l.ask(step, s, scope, request)
	close(finished)
	<-joined
	if errors.Is(context.Cause(step), errPreempted) {
		message.Interrupted = true
		return message, errPreempted
	}
	return message, err
}
