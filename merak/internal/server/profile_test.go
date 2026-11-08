package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestProfilesListDefaultsAndSaveAnOwnedCopy(t *testing.T) {
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
	var defaults []profile.Profile
	if err := client.Call(ctx, "profile.list", map[string]any{"human": "owner"}, &defaults); err != nil {
		t.Fatal(err)
	}
	if len(defaults) != 2 || defaults[0].Role != profile.Leader || defaults[1].Role != profile.Worker || defaults[0].ID == "" || defaults[1].ID == "" {
		t.Fatalf("defaults=%+v", defaults)
	}
	draft := defaults[1]
	draft.ID, draft.Name, draft.Duties = "", "Documentation", "Write and verify documentation."
	var saved profile.Profile
	if err := client.Call(ctx, "profile.save", map[string]any{"human": "owner", "profile": draft}, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.ID == "" || saved.ID == defaults[1].ID {
		t.Fatalf("copy id=%s", saved.ID)
	}
	saved.Name = "Documentation reviewer"
	if err := client.Call(ctx, "profile.save", map[string]any{"human": "other", "profile": saved}, new(profile.Profile)); err == nil {
		t.Fatal("another human changed an owned profile")
	}
	if err := client.Call(ctx, "profile.save", map[string]any{"human": "owner", "profile": saved}, new(profile.Profile)); err != nil {
		t.Fatal(err)
	}
	var list []profile.Profile
	if err := client.Call(ctx, "profile.list", map[string]any{"human": "owner"}, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[2].Name != saved.Name || list[2].Duties != draft.Duties {
		t.Fatalf("profiles=%+v", list)
	}
	if err := client.Call(ctx, "profile.list", map[string]any{"human": "other"}, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatal("private profile leaked to another human")
	}
	if err := client.Call(ctx, "profile.save", map[string]any{"human": "owner", "profile": defaults[0]}, new(profile.Profile)); err == nil {
		t.Fatal("builtin profile was overwritten")
	}
	for _, tc := range []struct {
		name   string
		change func(*profile.Profile)
	}{
		{"external leader", func(p *profile.Profile) {
			p.Role = profile.Leader
			p.Product = &profile.Product{Kind: worker.KindClaudeCode, Binary: "claude"}
		}},
		{"unknown product", func(p *profile.Profile) { p.Product = &profile.Product{Kind: "unknown", Binary: "anything"} }},
		{"missing binary", func(p *profile.Profile) { p.Product = &profile.Product{Kind: worker.KindCommand} }},
		{"leader tools on worker", func(p *profile.Profile) { p.ToolPool = "leader.default" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := defaults[1]
			bad.ID = ""
			tc.change(&bad)
			if err := client.Call(ctx, "profile.save", map[string]any{"human": "owner", "profile": bad}, new(profile.Profile)); err == nil {
				t.Fatal("invalid profile was saved")
			}
		})
	}
}

func TestRegisterAddsAnOwnedProfileAsAGroupMember(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir})
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
	var g group.Group
	if err := client.Call(ctx, "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, Members: []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader", Owner: "owner"},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}}, &g); err != nil {
		t.Fatal(err)
	}
	p := profile.DefaultWorker()
	p.Name = "Reviewer"
	var saved profile.Profile
	if err := client.Call(ctx, "profile.save", map[string]any{"human": "owner", "profile": p}, &saved); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"group": g.ID, "human": "outsider", "member": group.Member{Name: "Reviewer", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: saved.ID, Owner: "owner"}}
	if err := client.Call(ctx, "member.register", params, new(group.Member)); err == nil {
		t.Fatal("nonmember registered a worker")
	}
	params["human"] = "owner"
	var member group.Member
	if err := client.Call(ctx, "member.register", params, &member); err != nil {
		t.Fatal(err)
	}
	if member.ID == "" || member.Group != g.ID || member.Owner != "owner" || member.Profile != saved.ID {
		t.Fatalf("member=%+v", member)
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil || len(state.Members) != 3 {
		t.Fatalf("members=%+v err=%v", state.Members, err)
	}
}
