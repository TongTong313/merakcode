package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

type memberExecution struct{ group, member event.ID }

func (e *Engine) acquireMember(ctx context.Context, scope event.Scope, member event.ID) (func(), error) {
	if member == "" {
		return func() {}, nil
	}
	groupID, memberID := e.executionSource(scope, member)
	key := memberExecution{groupID, memberID}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		e.memberMu.Lock()
		if e.memberExecutions == nil {
			e.memberExecutions = make(map[memberExecution]chan struct{})
		}
		previous := e.memberExecutions[key]
		if previous == nil {
			done := make(chan struct{})
			e.memberExecutions[key] = done
			e.memberMu.Unlock()
			e.memberChanged()
			return func() {
				e.memberMu.Lock()
				delete(e.memberExecutions, key)
				close(done)
				e.memberMu.Unlock()
				e.memberChanged()
			}, nil
		}
		e.memberMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-e.ctx.Done():
			return nil, e.ctx.Err()
		case <-previous:
		}
	}
}

func (e *Engine) memberChanged() {
	select {
	case e.memberChanges <- struct{}{}:
	default:
	}
}
