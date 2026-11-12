package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestGroupAddMemberRequiresAnAdmin(t *testing.T) {
	ctx := context.Background()
	e, err := engine.New(engine.Deps{})
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
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Roles", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, human := range []string{"", "observer", "owner"} {
		params := map[string]any{"group": g.ID, "member": group.Member{ID: "added", Name: "Added", Kind: group.MemberHuman, Role: "member"}}
		caller := client
		if human != "" {
			caller = as(event.ID(human))
		}
		err := caller.Call(ctx, "group.addMember", params, new(group.Member))
		if human == "owner" && err != nil {
			t.Fatal(err)
		}
		if human != "owner" && err == nil {
			t.Fatalf("%q added a member", human)
		}
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil || len(state.Members) != 4 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	for _, method := range []string{"group.removeMember"} {
		if err := as("observer").Call(ctx, method, map[string]any{"group": g.ID, "member": "added"}, new(struct{})); err == nil {
			t.Fatal("observer removed a member")
		}
		if err := as("owner").Call(ctx, method, map[string]any{"group": g.ID, "member": "added"}, new(struct{})); err != nil {
			t.Fatal(err)
		}
		state, err := e.Groups.Get(ctx, g.ID)
		if err != nil || len(state.Members) != 3 {
			t.Fatalf("removal was not reflected: %+v %v", state, err)
		}
	}
}

func TestGroupRenameMemberRequiresAnAdminAndKeepsNamesMentionable(t *testing.T) {
	ctx := context.Background()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	as := func(human event.ID) *protocol.Client {
		return connectServerAs(t, handler, host, human, protocol.Capabilities{})
	}
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Roles", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	rename := func(human event.ID, name string) (group.Member, error) {
		var renamed group.Member
		err := as(human).Call(ctx, "group.renameMember", map[string]any{"group": g.ID, "member": "worker", "name": name}, &renamed)
		return renamed, err
	}
	if _, err := rename("observer", "Poet"); err == nil {
		t.Fatal("an observer renamed a member")
	}
	if _, err := rename("owner", "Fast Poet"); err == nil {
		t.Fatal("a name with a space was accepted")
	}
	renamed, err := rename("owner", "Poet")
	if err != nil || renamed.Name != "Poet" {
		t.Fatalf("renamed=%+v err=%v", renamed, err)
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range state.Members {
		if member.ID == "worker" && member.Name != "Poet" {
			t.Fatalf("the roster still says %q", member.Name)
		}
	}
}
