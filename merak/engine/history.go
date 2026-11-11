package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"slices"
	"strings"
	"time"
)

func (e *Engine) ReadEvents(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	return e.store.Read(ctx, stream, from, limit)
}
func (e *Engine) FindEvents(ctx context.Context, q store.Query) ([]event.Event, error) {
	discovery := q.Scope.Group == "" && slices.Contains(q.Types, group.Created)
	if discovery && e.CloudStatus().Online {
		e.cloudMu.Lock()
		host := e.cloudHost
		e.cloudMu.Unlock()
		request, cancel := context.WithTimeout(ctx, 2*time.Second)
		body, _ := json.Marshal(store.Query{Types: []event.Type{group.Created}})
		result, err := e.forwardFromHost(request, host, "events.find", body)
		if err == nil {
			var facts []event.Event
			if err = json.Unmarshal(result, &facts); err == nil {
				for _, fact := range facts {
					if fact.Type != group.Created {
						cancel()
						return nil, errors.New("MRK-1007")
					}
				}
				err = e.importCloudFrom(request, host, facts)
			}
		}
		cancel()
		if err != nil && ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	facts, err := e.store.Find(ctx, q)
	if err != nil || !discovery {
		return facts, err
	}
	return slices.DeleteFunc(facts, func(fact event.Event) bool {
		owner, hosted := e.hostedGroups.Load(fact.Scope.Group)
		return hosted && (strings.HasPrefix(owner.(string), "remote:") || !e.currentCloudGroup(ctx, fact.Scope.Group))
	}), nil
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
		return state, e.snapshotPermissions(ctx, &state)
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
	if err == nil {
		err = e.snapshotPermissions(ctx, &state)
	}
	return state, err
}

func (e *Engine) snapshotPermissions(ctx context.Context, state *session.State) error {
	facts, err := e.PendingPermissions(ctx)
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
func (e *Engine) SearchSessions(ctx context.Context, text string, limit int) ([]session.Hit, error) {
	return e.manager.Search(ctx, text, limit)
}

// ExportSession returns every event of a conversation, ready to be imported again.
func (e *Engine) ExportSession(ctx context.Context, id event.ID) ([]event.Event, error) {
	return e.manager.Export(ctx, id)
}

// ImportSession adds an exported conversation as a new one and returns its id.
func (e *Engine) ImportSession(ctx context.Context, facts []event.Event) (event.ID, error) {
	return e.manager.Import(ctx, facts, e.newID)
}
