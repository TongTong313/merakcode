package server_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestOnlyOwnerCanReplaceDefaultLeaderWithALocalLeader(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	host, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Leaders", DefaultLeader: "first", Project: group.Project{Directory: dir}, Settings: group.Settings{Review: new(false)}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
		{ID: "first", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "second", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "remote", Name: "Remote", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Remote: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		human, leader string
		allowed       bool
	}{{"admin", "second", false}, {"owner", "remote", false}, {"owner", "missing", false}, {"owner", "second", true}} {
		var changed group.Group
		err := client.Call(ctx, "group.update", map[string]any{"group": g.ID, "human": test.human, "defaultLeader": test.leader}, &changed)
		if (err == nil) != test.allowed {
			t.Fatalf("human=%s leader=%s error=%v", test.human, test.leader, err)
		}
		if test.allowed && (changed.DefaultLeader != "second" || changed.Settings.ReviewRequired()) {
			t.Fatalf("group update lost fields: %+v", changed)
		}
	}
	card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "New goal"})
	if err != nil || card.Leader != event.ID("second") {
		t.Fatalf("task leader=%s %v", card.Leader, err)
	}
}
