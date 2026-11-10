package worker

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/loop"
)

// BudgetExceeded preserves the engine's stop reason through process cancellation.
type BudgetExceeded struct{ Limit loop.StopReason }

func (e BudgetExceeded) Error() string { return "worker budget exhausted: " + string(e.Limit) }

func Termination(ctx context.Context, runErr error, stop loop.StopReason) (loop.StopReason, error) {
	var budget BudgetExceeded
	if errors.As(context.Cause(ctx), &budget) {
		return budget.Limit, nil
	}
	if ctx.Err() != nil {
		return loop.Cancelled, ctx.Err()
	}
	if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
		return loop.Cancelled, runErr
	}
	if runErr != nil {
		return loop.Failed, runErr
	}
	return stop, nil
}
