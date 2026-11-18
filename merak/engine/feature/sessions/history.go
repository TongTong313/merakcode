package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/feature/plan"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (e *Sessions) FindEvents(ctx context.Context, q store.Query) ([]event.Event, error) {
	discovery := q.Scope.Group == "" && slices.Contains(q.Types, group.Created)
	if discovery && e.remote.CloudStatus().Online {
		if err := e.remote.DiscoverGroups(ctx); err != nil {
			return nil, err
		}
	}
	facts, err := e.core.Store.Find(ctx, q)
	if err != nil || !discovery {
		return facts, err
	}
	return slices.DeleteFunc(facts, func(fact event.Event) bool {
		owner, hosted := e.roster.HostedGroup(fact.Scope.Group)
		return hosted && (strings.HasPrefix(owner.(string), "remote:") || !e.remote.CurrentCloudGroup(ctx, fact.Scope.Group))
	}), nil
}

// ExportSession returns every event of a conversation, ready to be imported again.
func (e *Sessions) ExportSession(ctx context.Context, id event.ID) ([]event.Event, error) {
	return e.manager.Export(ctx, id)
}

// ImportSession adds an exported conversation as a new one and returns its id.
func (e *Sessions) ImportSession(ctx context.Context, facts []event.Event) (event.ID, error) {
	return e.manager.Import(ctx, facts, e.core.NewID)
}

// ImportConversation adds a conversation of an earlier version as a new one and returns its id. The system prompt
// is composed here, as for a new conversation in its folder, because the earlier prompt is not carried over; a
// folder that is gone only loses its rules and skills.
func (e *Sessions) ImportConversation(ctx context.Context, facts []event.Event) (event.ID, error) {
	if len(facts) == 0 || facts[0].Type != session.Created {
		return "", errors.New("an imported conversation starts with session.created")
	}
	created, err := event.Decode[session.State](facts[0])
	if err != nil {
		return "", err
	}
	if created.System == "" {
		created.System, _, err = e.conversation.ComposeSystem(ctx, conversation.SessionOptions{Workdir: created.Config.Workdir, Parent: created.Config.Parent})
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
func (e *Sessions) ImportPlan(ctx context.Context, id event.ID, content string, status plan.Status) (plan.Plan, error) {
	value, err := e.plans.Import(ctx, id, content, status)
	return value, planError(err)
}

// ImportNote stores a memory note of an earlier version with the id and time it had. A note that looks like it holds
// a credential is refused with memory.ErrSecret.
func (e *Sessions) ImportNote(ctx context.Context, note memory.Note) (memory.Note, error) {
	return e.notes.Remember(ctx, note)
}

// Notify puts a notice into the inbox of a person, addressed to them.
func (e *Sessions) Notify(ctx context.Context, human event.ID, notice group.Notice) error {
	notice.To = []event.ID{human}
	body, err := json.Marshal(notice)
	if err != nil {
		return err
	}
	stream := event.Stream("inbox:" + human)
	e.scheduleNoticeMu.Lock()
	defer e.scheduleNoticeMu.Unlock()
	if err := store.ResumeStream(ctx, e.core.Bus, e.core.Store, stream); err != nil {
		return err
	}
	_, err = e.core.Bus.Publish(ctx, event.Event{Stream: stream, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorSystem}, Payload: body})
	return err
}

const importKind = "import"

// ReadImport returns the record a migration keeps under a key, with its revision; store.ErrNotFound when there is
// none.
func (e *Sessions) ReadImport(ctx context.Context, key string) ([]byte, uint64, error) {
	doc, err := e.core.Store.Fetch(ctx, importKind, key)
	if err != nil {
		return nil, 0, err
	}
	return doc.Body, doc.Rev, nil
}

// WriteImport saves the record of a migration; rev is the revision that was read, 0 for a record that is new.
func (e *Sessions) WriteImport(ctx context.Context, key string, body []byte, rev uint64) error {
	return e.core.Store.Put(ctx, store.Doc{Kind: importKind, Key: key, Rev: rev, Body: body})
}
