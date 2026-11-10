package loop

import (
	"context"
	"time"
)

// wallClock rechecks an extendable deadline before interrupting an active request.
func (l *Loop) wallClock(ctx context.Context, deadline time.Time) (context.Context, context.CancelFunc) {
	if l.Deadline == nil {
		return context.WithDeadlineCause(ctx, deadline, errWallClock)
	}
	ctx, cancel := context.WithCancelCause(ctx)
	timer := time.NewTimer(time.Until(deadline))
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				next, err := l.Deadline(ctx)
				if err != nil {
					cancel(err)
					return
				}
				if !next.IsZero() && time.Now().Before(next) {
					timer.Reset(time.Until(next))
					continue
				}
				cancel(errWallClock)
				return
			}
		}
	}()
	return ctx, func() { cancel(nil); <-done }
}
