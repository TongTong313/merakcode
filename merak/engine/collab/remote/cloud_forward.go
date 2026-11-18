package remote

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/secret"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// ForwardCloud leaves cloud-owned commands and history interpretation to the host.
func (domain *Remote) ForwardCloud(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, bool, error) {
	switch method {
	case "group.create", "group.say", "group.update", "group.addMember", "group.removeMember", "group.state", "task.create", "task.assign", "task.update", "task.cancel", "task.review", "group.bind", "member.register", "member.remove", "doc.list", "doc.read", "doc.write", "permission.reply", "question.reply", "event.emit", "events.read", "events.find", "events.get", "session.snapshot", "session.send", "session.cancel":
	default:
		return nil, false, nil
	}
	var target struct {
		Kind    group.Kind   `json:"kind"`
		Group   event.ID     `json:"group"`
		Task    event.ID     `json:"task"`
		Session event.ID     `json:"session"`
		Request event.ID     `json:"request"`
		ID      event.ID     `json:"id"`
		Stream  event.Stream `json:"stream"`
		Scope   event.Scope  `json:"scope"`
	}
	if json.Unmarshal(params, &target) != nil {
		return nil, false, nil
	}
	domain.cloudMu.Lock()
	host := domain.cloudHost
	domain.cloudMu.Unlock()
	groupID := target.Group
	if groupID == "" {
		groupID = target.Scope.Group
	}
	if groupID == "" && strings.HasPrefix(string(target.Stream), "group:") {
		groupID = event.ID(strings.TrimPrefix(string(target.Stream), "group:"))
	}
	if groupID == "" && target.Task != "" {
		if card, err := domain.tasks.Get(ctx, target.Task); err == nil {
			groupID = card.Group
		}
	}
	for _, id := range []event.ID{target.Request, target.ID} {
		if groupID == "" && id != "" {
			if fact, err := domain.core.Store.Get(ctx, id); err == nil {
				groupID = fact.Scope.Group
			} else if doc, err := domain.core.Store.Fetch(ctx, "cloud-ref", "event:"+string(id)); err == nil {
				groupID = event.ID(doc.Meta["group"])
			}
		}
	}
	sessionID := target.Session
	if sessionID == "" {
		sessionID = target.Scope.Session
	}
	if sessionID == "" && strings.HasPrefix(string(target.Stream), "session:") {
		sessionID = event.ID(strings.TrimPrefix(string(target.Stream), "session:"))
	}
	if groupID == "" && sessionID != "" {
		facts, err := domain.core.Store.Read(ctx, event.Stream("session:"+sessionID), 1, 1)
		if err == nil && len(facts) > 0 {
			groupID = facts[0].Scope.Group
		}
		if groupID == "" {
			if doc, err := domain.core.Store.Fetch(ctx, "cloud-ref", "session:"+string(sessionID)); err == nil {
				groupID = event.ID(doc.Meta["group"])
			}
		}
	}
	selected := method == "group.create" && target.Kind == group.KindCloud
	if selected && target.Task != "" {
		return nil, true, errorcode.Coded(errorcode.CloudGroupTakesNoTask, errors.New("cloud groups do not take tasks yet"))
	}
	if !selected && groupID != "" {
		owner, exists := domain.roster.HostedGroup(groupID)
		if exists && strings.HasPrefix(owner.(string), "remote:") {
			switch method {
			case "group.state", "events.read", "events.find", "events.get", "session.snapshot":
				return nil, false, nil
			default:
				return nil, true, errors.New("MRK-6001")
			}
		}
		selected = exists
		if !selected {
			_, err := domain.core.Store.Fetch(ctx, "cloud-group", string(groupID))
			selected = err == nil
		}
	}
	if !selected {
		return nil, false, nil
	}
	if method == "group.bind" {
		return nil, true, errorcode.Coded(errorcode.CloudGroupTakesNoTask, errors.New("cloud groups do not take tasks yet"))
	}
	if host == nil || groupID != "" && !domain.cloudGroupOwnedBy(ctx, groupID, host.id) {
		return nil, true, wire.ErrNoCloud
	}
	result, err := domain.forwardCloudForHost(ctx, host, method, params)
	if err == nil && (method == "events.read" || method == "events.find" || method == "events.get") {
		var facts []event.Event
		if method == "events.get" {
			var fact event.Event
			err = json.Unmarshal(result, &fact)
			facts = []event.Event{fact}
		} else {
			err = json.Unmarshal(result, &facts)
		}
		if err == nil {
			err = domain.importCloudFrom(ctx, host, facts)
		}
	}
	return result, true, err
}

func (domain *Remote) forwardFromHost(ctx context.Context, host *deviceHost, method string, params json.RawMessage) (json.RawMessage, error) {
	domain.cloudMu.Lock()
	link, current := domain.cloud, host != nil && domain.cloudHost == host
	domain.cloudMu.Unlock()
	if !current {
		return nil, wire.ErrNoCloud
	}
	return link.Forward(ctx, method, params)
}

func (domain *Remote) indexCloudFact(ctx context.Context, host *deviceHost, fact event.Event) error {
	ids := []event.ID{fact.Scope.Session}
	if fact.Type == leader.ThreadStarted || fact.Type == leader.ThreadHandedOver {
		thread, err := event.Decode[leader.Handover](fact)
		if err != nil {
			return err
		}
		ids = append(ids, thread.Session)
	}
	if strings.HasPrefix(string(fact.Type), "task.") || fact.Type == task.PhaseChanged {
		var card task.Card
		if json.Unmarshal(fact.Payload, &card) == nil {
			for _, claim := range card.Claims {
				ids = append(ids, claim.Session)
			}
		}
	}
	for _, id := range ids {
		if id == "" {
			continue
		}
		if err := domain.indexCloudReference(ctx, host, "session:"+string(id), fact.Scope.Group); err != nil {
			return err
		}
	}
	return nil
}

func (domain *Remote) indexCloudReference(ctx context.Context, host *deviceHost, key string, groupID event.ID) error {
	doc, err := domain.core.Store.Fetch(ctx, "cloud-ref", key)
	if err == nil {
		if doc.Meta["host"] != host.id || doc.Meta["group"] != string(groupID) {
			return store.ErrConflict
		}
		return nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return domain.core.Store.Put(ctx, store.Doc{Kind: "cloud-ref", Key: key, Body: []byte(`{}`), Meta: map[string]string{"host": host.id, "group": string(groupID)}})
}

func (domain *Remote) CurrentCloudGroup(ctx context.Context, id event.ID) bool {
	domain.cloudMu.Lock()
	account := wire.Identity(domain.cloudCredentials)
	domain.cloudMu.Unlock()
	return domain.cloudGroupOwnedBy(ctx, id, account)
}

func (domain *Remote) cloudGroupOwnedBy(ctx context.Context, id event.ID, account string) bool {
	if account == "" {
		return false
	}
	if owner, ok := domain.roster.HostedGroup(id); ok && owner == account {
		return true
	}
	doc, err := domain.core.Store.Fetch(ctx, "cloud-group", string(id))
	return err == nil && doc.Meta["host"] == account
}

func (domain *Remote) ForwardCloudRequest(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	domain.cloudMu.Lock()
	host := domain.cloudHost
	domain.cloudMu.Unlock()
	return domain.forwardCloudForHost(ctx, host, method, params)
}

func (domain *Remote) forwardCloudForHost(ctx context.Context, host *deviceHost, method string, params json.RawMessage) (json.RawMessage, error) {
	params, err := cloudParams(params)
	if err != nil {
		return nil, err
	}
	result, err := domain.forwardFromHost(ctx, host, method, params)
	if err != nil {
		return nil, err
	}
	if method == "group.create" {
		var created group.Group
		if json.Unmarshal(result, &created) != nil || created.ID == "" || created.Kind != group.KindCloud {
			return nil, wire.ErrUnavailable
		}
		host.imports.Lock()
		defer host.imports.Unlock()
		doc, err := domain.core.Store.Fetch(ctx, "cloud-group", string(created.ID))
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		if err == nil && doc.Meta["host"] != host.id {
			return nil, store.ErrConflict
		}
		if err = domain.core.Store.Put(ctx, store.Doc{Kind: "cloud-group", Key: string(created.ID), Rev: doc.Rev, Body: result, Meta: map[string]string{"host": host.id}}); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// cloudParams keeps secrets out of what is forwarded to the cloud. Agents travel as ids, so no environment value of an
// agent is part of a forwarded request.
func cloudParams(body json.RawMessage) (json.RawMessage, error) { return secret.RedactJSON(body) }
