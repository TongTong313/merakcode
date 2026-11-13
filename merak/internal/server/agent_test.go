package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestAgentsListDefaultsAndSaveAnOwnedCopy(t *testing.T) {
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
	as := func(human event.ID) *protocol.Client {
		return connectServerAs(t, handler, host, human, protocol.Capabilities{})
	}
	var defaults []agent.Agent
	if err := as("owner").Call(ctx, "agent.list", struct{}{}, &defaults); err != nil {
		t.Fatal(err)
	}
	if len(defaults) != 1 || defaults[0].ID != "builtin-merakcode" {
		t.Fatalf("defaults=%+v", defaults)
	}
	draft := defaults[0]
	draft.ID, draft.Name, draft.Duties = "", "Documentation", "Write and verify documentation."
	var saved agent.Agent
	if err := as("owner").Call(ctx, "agent.save", map[string]any{"agent": draft}, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.ID == "" || saved.ID == defaults[0].ID {
		t.Fatalf("copy id=%s", saved.ID)
	}
	saved.Name = "Documentation reviewer"
	if err := as("other").Call(ctx, "agent.save", map[string]any{"agent": saved}, new(agent.Agent)); err == nil {
		t.Fatal("another human changed an owned profile")
	}
	if err := as("owner").Call(ctx, "agent.save", map[string]any{"agent": saved}, new(agent.Agent)); err != nil {
		t.Fatal(err)
	}
	var list []agent.Agent
	if err := as("owner").Call(ctx, "agent.list", struct{}{}, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[1].Name != saved.Name || list[1].Duties != draft.Duties {
		t.Fatalf("profiles=%+v", list)
	}
	if err := as("other").Call(ctx, "agent.list", struct{}{}, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatal("private profile leaked to another human")
	}
	if err := as("other").Call(ctx, "agent.delete", map[string]any{"agent": saved.ID}, new(struct{})); err == nil {
		t.Fatal("another human deleted an owned profile")
	}
	if err := as("owner").Call(ctx, "agent.delete", map[string]any{"agent": saved.ID}, new(struct{})); err != nil {
		t.Fatal(err)
	}
	if err := as("owner").Call(ctx, "agent.list", struct{}{}, &list); err != nil || len(list) != 1 {
		t.Fatalf("deleted profile remains visible: %+v %v", list, err)
	}
	if err := as("owner").Call(ctx, "agent.save", map[string]any{"profile": defaults[0]}, new(agent.Agent)); err == nil {
		t.Fatal("builtin profile was overwritten")
	}
	for _, tc := range []struct {
		name   string
		change func(*agent.Agent)
	}{
		{"unknown product", func(p *agent.Agent) { p.Product = &agent.Product{Kind: "unknown", Binary: "anything"} }},
		{"missing binary", func(p *agent.Agent) { p.Product = &agent.Product{Kind: worker.KindCommand} }},
		{"leader tools on worker", func(p *agent.Agent) { p.ToolPool = "leader.default" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := defaults[0]
			bad.ID = ""
			tc.change(&bad)
			if err := as("owner").Call(ctx, "agent.save", map[string]any{"agent": bad}, new(agent.Agent)); err == nil {
				t.Fatal("invalid profile was saved")
			}
		})
	}
}

func TestAnOwnedAgentJoinsAGroupByItsId(t *testing.T) {
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
	as := func(human event.ID) *protocol.Client {
		return connectServerAs(t, handler, host, human, protocol.Capabilities{})
	}
	var g group.Group
	if err := client.Call(ctx, "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, Members: []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode", Owner: "owner"},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}}, &g); err != nil {
		t.Fatal(err)
	}
	p := agent.DefaultMerakCode()
	p.Name = "Reviewer"
	var saved agent.Agent
	if err := as("owner").Call(ctx, "agent.save", map[string]any{"agent": p}, &saved); err != nil {
		t.Fatal(err)
	}
	params := map[string]any{"group": g.ID, "member": group.Member{Name: "Reviewer", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: saved.ID, Owner: "owner"}}
	if err := as("outsider").Call(ctx, "group.addMember", params, new(group.Member)); err == nil {
		t.Fatal("nonmember registered a worker")
	}
	var member group.Member
	if err := as("owner").Call(ctx, "group.addMember", params, &member); err != nil {
		t.Fatal(err)
	}
	if member.ID == "" || member.Group != g.ID || member.Owner != "owner" || member.Agent != saved.ID {
		t.Fatalf("member=%+v", member)
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil || len(state.Members) != 3 {
		t.Fatalf("members=%+v err=%v", state.Members, err)
	}
	if err := as("owner").Call(ctx, "agent.delete", protocol.AgentDeleteParams{Agent: saved.ID}, nil); err == nil {
		t.Fatal("deleted an agent still referenced by a group member")
	}
	if err := as("owner").Call(ctx, "group.removeMember", protocol.GroupRemoveMemberParams{Group: g.ID, Member: member.ID}, nil); err != nil {
		t.Fatal(err)
	}
	if err := as("owner").Call(ctx, "agent.delete", protocol.AgentDeleteParams{Agent: saved.ID}, nil); err != nil {
		t.Fatal(err)
	}
}
