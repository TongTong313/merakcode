package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func (e *Engine) ReadEvents(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	return e.store.Read(ctx, stream, from, limit)
}
func (e *Engine) FindEvents(ctx context.Context, q store.Query) ([]event.Event, error) {
	return e.store.Find(ctx, q)
}
func (e *Engine) GetEvent(ctx context.Context, id event.ID) (event.Event, error) {
	return e.store.Get(ctx, id)
}
func (e *Engine) ListSessions(ctx context.Context) ([]session.Info, error) {
	return e.manager.List(ctx)
}

// SessionSnapshot returns an immutable persisted checkpoint; callers read subsequent events by sequence.
func (e *Engine) SessionSnapshot(ctx context.Context, id event.ID) (session.State, error) {
	var state session.State
	doc, err := e.store.Fetch(ctx, "snapshot", string(id))
	if err == nil {
		if err := json.Unmarshal(doc.Body, &state); err != nil {
			return state, err
		}
		if state.ID != id {
			return state, store.ErrConflict
		}
		return state, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return state, err
	}
	facts, err := e.store.Read(ctx, event.Stream("session:"+id), 1, 1)
	if err != nil {
		return state, err
	}
	if len(facts) == 0 || facts[0].Type != session.Created {
		return state, store.ErrNotFound
	}
	err = session.Fold(&state, facts[0])
	return state, err
}
