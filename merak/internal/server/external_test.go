package server_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestExternalEventRPCPreservesPayloadAndCannotForgeEngineFacts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "External events", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, group, kind string
		payload           any
		valid             bool
	}{
		{"valid", string(g.ID), "external.ci.finished", map[string]any{"status": "success", "paths": []string{"docs/guide.md"}}, true},
		{"nonbreaking space", string(g.ID), "external.ci\u00a0done", map[string]any{}, false},
		{"vertical tab", string(g.ID), "external.ci\vdone", map[string]any{}, false},
		{"next line", string(g.ID), "external.ci\u0085done", map[string]any{}, false},
		{"byte order mark", string(g.ID), "external.ci\ufeffdone", map[string]any{}, false},
		{"engine type", string(g.ID), "task.reported", map[string]any{}, false},
		{"empty suffix", string(g.ID), "external.", map[string]any{}, false},
		{"missing group", "missing", "external.ci.finished", map[string]any{}, false},
		{"invalid payload", string(g.ID), "external.ci.finished", nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var emitted event.Event
			err := client.Call(ctx, "event.emit", map[string]any{"group": test.group, "type": test.kind, "payload": test.payload}, &emitted)
			if !test.valid {
				if err == nil || err.Error() != "MRK-6001" {
					t.Fatalf("invalid event: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var saved event.Event
			if err := client.Call(ctx, "events.get", protocol.EventsGetParams{ID: emitted.ID}, &saved); err != nil {
				t.Fatal(err)
			}
			if saved.ID == "" || saved.Type != event.Type(test.kind) || saved.Actor.Kind != event.ActorExternal || saved.Stream != event.Stream("group:"+g.ID) || saved.Scope.Group != g.ID {
				t.Fatalf("event=%+v", saved)
			}
			var payload struct {
				Status string   `json:"status"`
				Paths  []string `json:"paths"`
			}
			if err := json.Unmarshal(saved.Payload, &payload); err != nil || payload.Status != "success" || len(payload.Paths) != 1 || payload.Paths[0] != "docs/guide.md" {
				t.Fatalf("payload=%+v %v", payload, err)
			}
		})
	}
}

func TestGroupUpdateRPCChangesRunningTriggerSettings(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	directory := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: directory, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Rules", Project: group.Project{Directory: directory}, DefaultLeader: "leader", Settings: group.Settings{Initiative: group.Passive}}, []group.Member{
		{ID: "owner", Kind: group.MemberHuman, Role: group.RoleOwner, Name: "Owner"},
		{ID: "approver", Kind: group.MemberHuman, Role: group.RoleApprover, Name: "Approver"},
		{ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader", Profile: lead.ID},
	}, []profile.Profile{lead})
	if err != nil {
		t.Fatal(err)
	}
	settings := group.Settings{Initiative: group.Eager, Triggers: []group.Trigger{{ID: "ci", When: event.Filter{Types: []event.Type{"external.ci.finished"}}, Then: group.Action{Kind: group.CreateTask, Template: "Check CI result"}}}}
	var updated group.Group
	if err := client.Call(ctx, "group.update", map[string]any{"group": g.ID, "human": "approver", "settings": settings}, &updated); err == nil || err.Error() != "MRK-6001" {
		t.Fatalf("approver updated settings: %v", err)
	}
	if err := client.Call(ctx, "group.update", map[string]any{"group": g.ID, "human": "owner", "settings": settings}, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Settings.Initiative != group.Eager {
		t.Fatalf("settings=%+v", updated.Settings)
	}
	if err := client.Call(ctx, "event.emit", protocol.EventEmitParams{Group: g.ID, Type: "external.ci.finished", Payload: json.RawMessage(`{}`)}, new(event.Event)); err != nil {
		t.Fatal(err)
	}
	for {
		cards, err := e.Tasks.List(ctx, g.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(cards) == 1 && cards[0].Title == "Check CI result" {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("running group did not apply the updated rule")
		case <-time.After(10 * time.Millisecond):
		}
	}
}
