package group_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestGroupSettingsRequireAnAdminAndSurviveReload(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := group.New(storage, bus, event.NewID)
	g, err := manager.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Settings", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader", Settings: group.Settings{Initiative: group.Passive}}, []group.Member{
		{ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader"},
		{ID: "worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Name: "Worker"},
		{ID: "admin", Kind: group.MemberHuman, Role: group.RoleAdmin, Name: "Admin"},
		{ID: "approver", Kind: group.MemberHuman, Role: group.RoleApprover, Name: "Approver"},
	})
	if err != nil {
		t.Fatal(err)
	}
	settings := group.Settings{Initiative: group.Eager, Triggers: []group.Trigger{{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed"}}, Where: "docs/**/*.md", Then: group.Action{Kind: group.CreateTask, Template: "Sync docs", Member: "worker"}}}}
	if _, err := manager.Update(ctx, g.ID, "approver", group.Update{Settings: &settings}); err == nil {
		t.Fatal("approver changed group settings")
	}
	if _, err := manager.Update(ctx, g.ID, "admin", group.Update{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	saved, err := group.New(storage, bus, event.NewID).Get(ctx, g.ID)
	if err != nil || !reflect.DeepEqual(saved.Group.Settings, settings) {
		t.Fatalf("settings=%+v %v", saved.Group.Settings, err)
	}
	for _, invalid := range []group.Settings{{Initiative: "unknown"}, {Triggers: []group.Trigger{{ID: "assign", When: event.Filter{Types: []event.Type{"external.ready"}}, Then: group.Action{Kind: group.AssignMember, Member: "missing"}}}}} {
		if _, err := manager.Update(ctx, g.ID, "admin", group.Update{Settings: &invalid}); err == nil {
			t.Fatal("invalid settings accepted")
		}
	}
	for _, raw := range []string{`{"turnsPerMinute":{"thread":0}}`, `{"turnsPerMinute":{"group":-1}}`, `{"turnsPerMinute":{"thread":1.5}}`} {
		var invalid group.Settings
		if err := json.Unmarshal([]byte(raw), &invalid); err != nil {
			continue
		}
		if _, err := manager.Update(ctx, g.ID, "admin", group.Update{Settings: &invalid}); err == nil {
			t.Fatalf("invalid rate accepted: %s", raw)
		}
	}
	for _, host := range []string{"example.*.com", "https://example.com", "example.com:65536", "*", ""} {
		t.Run("invalid host "+host, func(t *testing.T) {
			if _, err := manager.Update(ctx, g.ID, "admin", group.Update{Settings: &group.Settings{AllowedHosts: []string{host}}}); err == nil {
				t.Error("settings accepted an invalid network host")
			}
			if err := manager.AllowNetworkHost(ctx, g.ID, "admin", host); err == nil {
				t.Error("approval accepted an invalid network host")
			}
		})
	}
	saved, err = manager.Get(ctx, g.ID)
	if err != nil || !reflect.DeepEqual(saved.Group.Settings, settings) {
		t.Fatalf("invalid update changed settings=%+v %v", saved.Group.Settings, err)
	}
}

func TestAdminNetworkDenialsSurviveReloadAndRejectBareWildcards(t *testing.T) {
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := group.New(storage, bus, event.NewID)
	g, err := manager.Create(t.Context(), group.Group{Kind: group.KindLocal, Name: "Network", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
	})
	if err != nil {
		t.Fatal(err)
	}
	var settings group.Settings
	if err := json.Unmarshal([]byte(`{"deniedHosts":["*.blocked.example:443"]}`), &settings); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Update(t.Context(), g.ID, "approver", group.Update{Settings: &settings}); err == nil {
		t.Fatal("approver changed network denials")
	}
	if _, err := manager.Update(t.Context(), g.ID, "admin", group.Update{Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	state, err := group.New(storage, bus, event.NewID).Get(t.Context(), g.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(state.Group.Settings)
	var view struct{ DeniedHosts []string }
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(view.DeniedHosts, []string{"*.blocked.example:443"}) {
		t.Fatalf("denied hosts=%v", view.DeniedHosts)
	}
	if err := json.Unmarshal([]byte(`{"deniedHosts":["*"]}`), &settings); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Update(t.Context(), g.ID, "admin", group.Update{Settings: &settings}); err == nil {
		t.Fatal("bare wildcard accepted in network denials")
	}
}
