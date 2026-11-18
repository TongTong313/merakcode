package conversation

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Manager) ReadEvents(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	return domain.core.Store.Read(ctx, stream, from, limit)
}

func (domain *Manager) GetEvent(ctx context.Context, id event.ID) (event.Event, error) {
	return domain.core.Store.Get(ctx, id)
}

func (domain *Manager) ListSessions(ctx context.Context) ([]session.Info, error) {
	return domain.manager.List(ctx)
}

// SessionSnapshot returns an immutable persisted checkpoint; callers read subsequent events by sequence.
func (domain *Manager) SessionSnapshot(ctx context.Context, id event.ID) (session.State, error) {
	var state session.State
	doc, err := domain.core.Store.Fetch(ctx, "snapshot", string(id))
	if err == nil {
		if err := json.Unmarshal(doc.Body, &state); err != nil {
			return state, err
		}
		if state.ID != id {
			return state, store.ErrConflict
		}
		return state, domain.snapshotPermissions(ctx, &state)
	}
	if !errors.Is(err, store.ErrNotFound) {
		return state, err
	}
	facts, err := domain.core.Store.Read(ctx, event.Stream("session:"+id), 1, 1)
	if err != nil {
		return state, err
	}
	if len(facts) == 0 || facts[0].Type != session.Created {
		return state, store.ErrNotFound
	}
	err = session.Fold(&state, facts[0])
	if err == nil {
		err = domain.snapshotPermissions(ctx, &state)
	}
	return state, err
}

func (domain *Manager) snapshotPermissions(ctx context.Context, state *session.State) error {
	if domain.hooks.Pending == nil {
		state.Permissions = nil
		return nil
	}
	facts, err := domain.hooks.Pending(ctx)
	if err != nil {
		return err
	}
	state.Permissions = nil
	for _, fact := range facts {
		if fact.Scope.Session != state.ID || fact.Seq > state.LastSeq {
			continue
		}
		request, err := event.Decode[permission.Request](fact)
		if err != nil {
			return err
		}
		if state.Permissions == nil {
			state.Permissions = make(map[event.ID]permission.Pending)
		}
		state.Permissions[fact.ID] = permission.Pending{Request: request, Scope: fact.Scope, Time: fact.Time, Seq: fact.Seq}
	}
	return nil
}

// SearchSessions finds the conversations that have a message containing a text.
func (domain *Manager) SearchSessions(ctx context.Context, text string, limit int) ([]session.Hit, error) {
	return domain.manager.Search(ctx, text, limit)
}
