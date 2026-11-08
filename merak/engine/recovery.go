package engine

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Recover reconciles stored sessions before clients resume their work.
func (e *Engine) Recover(ctx context.Context) error {
	if err := e.recoverSessions(ctx); err != nil {
		return err
	}
	facts, err := e.store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return err
	}
	for _, fact := range facts {
		state, err := e.Groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return err
		}
		if err := e.startGroup(ctx, state.Group); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) recoverSessions(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	list, err := e.manager.List(ctx)
	if err != nil {
		return err
	}
	for _, info := range list {
		if e.sessions[info.ID] != nil || e.groupSessions[info.ID] {
			continue
		}
		state, err := e.manager.Load(ctx, info.ID)
		if err != nil {
			return err
		}
		if err := e.manager.Reconcile(ctx, state); err != nil {
			return err
		}
		if err := e.manager.Snapshot(ctx, state); err != nil {
			return err
		}
	}
	return nil
}
