package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
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
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Roles", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, human := range []string{"", "observer", "owner"} {
		params := map[string]any{"group": g.ID, "member": group.Member{ID: "added", Name: "Added", Kind: group.MemberHuman, Role: "member"}}
		if human != "" {
			params["human"] = human
		}
		err := client.Call(ctx, "group.addMember", params, new(group.Member))
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
	for _, method := range []string{"group.removeMember", "member.remove"} {
		if method == "member.remove" {
			if err := client.Call(ctx, "group.addMember", map[string]any{"group": g.ID, "human": "owner", "member": group.Member{ID: "added", Name: "Added", Kind: group.MemberHuman, Role: "member"}}, new(group.Member)); err != nil {
				t.Fatal(err)
			}
		}
		if err := client.Call(ctx, method, map[string]any{"group": g.ID, "human": "observer", "member": "added"}, new(struct{})); err == nil {
			t.Fatal("observer removed a member")
		}
		if err := client.Call(ctx, method, map[string]any{"group": g.ID, "human": "owner", "member": "added"}, new(struct{})); err != nil {
			t.Fatal(err)
		}
		state, err := e.Groups.Get(ctx, g.ID)
		if err != nil || len(state.Members) != 3 {
			t.Fatalf("removal was not reflected: %+v %v", state, err)
		}
	}
}
