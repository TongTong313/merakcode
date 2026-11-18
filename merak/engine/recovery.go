package engine

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// Recover reconciles stored sessions before clients resume their work.
func (e *Engine) Recover(ctx context.Context) error {
	if err := e.recoverSessions(ctx); err != nil {
		return err
	}
	facts, err := e.core.Store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return err
	}
	for _, fact := range facts {
		state, err := e.roster.Group(ctx, fact.Scope.Group)
		if err != nil {
			return err
		}
		if state.Group.Kind == group.KindCloud {
			doc, err := e.core.Store.Fetch(ctx, "cloud-group", string(state.Group.ID))
			if err != nil {
				return err
			}
			e.roster.HostGroup(state.Group.ID, doc.Meta["host"])
			continue
		}
		if doc, err := e.core.Store.Fetch(ctx, "remote-group", string(state.Group.ID)); err == nil {
			e.roster.HostGroup(state.Group.ID, doc.Meta["host"])
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if state.Group.Archived {
			continue
		}
		if err := e.coordinator.StartGroup(ctx, state.Group); err != nil {
			return err
		}
		if err := e.coordinator.RecoverTaskApprovals(ctx, state.Group.ID); err != nil {
			return err
		}
	}
	return e.conversation.RecoverWorkspaceConfirmations(ctx)
}

func (e *Engine) recoverSessions(ctx context.Context) error {
	list, err := e.conversation.ListSessions(ctx)
	if err != nil {
		return err
	}
	for _, info := range list {
		if e.conversation.Has(info.ID) || e.execution.HasGroupSession(info.ID) {
			continue
		}
		if _, err := e.core.Store.Fetch(ctx, "remote-stream", "session:"+string(info.ID)); err == nil {
			continue
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		state, err := e.conversation.LoadSession(ctx, info.ID)
		if err != nil {
			return err
		}
		if state.Scope.Group != "" {
			owner, err := e.roster.Group(ctx, state.Scope.Group)
			if err != nil {
				return err
			}
			_, remoteErr := e.core.Store.Fetch(ctx, "remote-group", string(owner.Group.ID))
			if remoteErr != nil && !errors.Is(remoteErr, store.ErrNotFound) {
				return remoteErr
			}
			if owner.Group.Kind == group.KindCloud || remoteErr == nil {
				if _, err := e.core.Store.Fetch(ctx, "cloud-stream", "session:"+string(info.ID)); errors.Is(err, store.ErrNotFound) {
					continue
				} else if err != nil {
					return err
				}
			}
		}
		if err := e.conversation.CheckpointSession(ctx, state); err != nil {
			return err
		}
	}
	return nil
}
