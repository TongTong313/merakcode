package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/plan"
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

// ImportConversation adds a conversation of an earlier version as a new one and returns its id. The system prompt
// is composed here, as for a new conversation in its folder, because the earlier prompt is not carried over; a
// folder that is gone only loses its rules and skills.
func (e *Engine) ImportConversation(ctx context.Context, facts []event.Event) (event.ID, error) {
	if len(facts) == 0 || facts[0].Type != session.Created {
		return "", errors.New("an imported conversation starts with session.created")
	}
	created, err := event.Decode[session.State](facts[0])
	if err != nil {
		return "", err
	}
	if created.System == "" {
		created.System, _, err = e.composeSystem(ctx, SessionOptions{Workdir: created.Config.Workdir, Parent: created.Config.Parent})
		if err != nil {
			return "", err
		}
		body, err := json.Marshal(created)
		if err != nil {
			return "", err
		}
		facts = slices.Clone(facts)
		facts[0].Payload = body
	}
	return e.ImportSession(ctx, facts)
}

// ImportPlan stores the plan of a conversation of an earlier version as it ended, Done or Stopped.
func (e *Engine) ImportPlan(ctx context.Context, id event.ID, content string, status plan.Status) (plan.Plan, error) {
	value, err := e.plans.Import(ctx, id, content, status)
	return value, planError(err)
}

// ImportNote stores a memory note of an earlier version with the id and time it had. A note that looks like it holds
// a credential is refused with memory.ErrSecret.
func (e *Engine) ImportNote(ctx context.Context, note memory.Note) (memory.Note, error) {
	return e.notes.Remember(ctx, note)
}

// Notify puts a notice into the inbox of a person, addressed to them.
func (e *Engine) Notify(ctx context.Context, human event.ID, notice group.Notice) error {
	notice.To = []event.ID{human}
	body, err := json.Marshal(notice)
	if err != nil {
		return err
	}
	stream := event.Stream("inbox:" + human)
	e.scheduleNoticeMu.Lock()
	defer e.scheduleNoticeMu.Unlock()
	if err := e.resumeDeviceStream(ctx, stream); err != nil {
		return err
	}
	_, err = e.Bus.Publish(ctx, event.Event{Stream: stream, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorSystem}, Payload: body})
	return err
}

const importKind = "import"

// ReadImport returns the record a migration keeps under a key, with its revision; store.ErrNotFound when there is
// none.
func (e *Engine) ReadImport(ctx context.Context, key string) ([]byte, uint64, error) {
	doc, err := e.store.Fetch(ctx, importKind, key)
	if err != nil {
		return nil, 0, err
	}
	return doc.Body, doc.Rev, nil
}

// WriteImport saves the record of a migration; rev is the revision that was read, 0 for a record that is new.
func (e *Engine) WriteImport(ctx context.Context, key string, body []byte, rev uint64) error {
	return e.store.Put(ctx, store.Doc{Kind: importKind, Key: key, Rev: rev, Body: body})
}
