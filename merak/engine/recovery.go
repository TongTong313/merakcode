package engine

import (
	"context"
	"errors"
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
		if state.Group.Kind == group.KindCloud {
			doc, err := e.store.Fetch(ctx, "cloud-group", string(state.Group.ID))
			if err != nil {
				return err
			}
			e.hostedGroups.Store(state.Group.ID, doc.Meta["host"])
			continue
		}
		if doc, err := e.store.Fetch(ctx, "remote-group", string(state.Group.ID)); err == nil {
			e.hostedGroups.Store(state.Group.ID, doc.Meta["host"])
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if state.Group.Archived {
			continue
		}
		if err := e.startGroup(ctx, state.Group); err != nil {
			return err
		}
		if err := e.recoverTaskApprovals(ctx, state.Group.ID); err != nil {
			return err
		}
	}
	return e.recoverWorkspaceConfirmations(ctx)
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
		if _, err := e.store.Fetch(ctx, "remote-stream", "session:"+string(info.ID)); err == nil {
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		state, err := e.manager.Load(ctx, info.ID)
		if err != nil {
			return err
		}
		if state.Scope.Group != "" {
			owner, err := e.Groups.Get(ctx, state.Scope.Group)
			if err != nil {
				return err
			}
			_, remoteErr := e.store.Fetch(ctx, "remote-group", string(owner.Group.ID))
			if remoteErr != nil && !errors.Is(remoteErr, store.ErrNotFound) {
				return remoteErr
			}
			if owner.Group.Kind == group.KindCloud || remoteErr == nil {
				if _, err := e.store.Fetch(ctx, "cloud-stream", "session:"+string(info.ID)); errors.Is(err, store.ErrNotFound) {
					continue
				} else if err != nil {
					return err
				}
			}
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
