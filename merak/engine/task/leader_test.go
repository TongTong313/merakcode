package task_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestChangingATaskLeaderRequiresAdminAndUpdatesDescendants(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "first"}, []group.Member{
		{ID: "first", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "second", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	root, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal", Leader: "second"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := pool.Create(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Child", Leader: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if root.Leader != "second" || child.Leader != "second" {
		t.Fatal("explicit leader or inheritance was lost")
	}
	for _, tc := range []struct {
		name  string
		id    event.ID
		actor event.Actor
		next  event.ID
		fail  bool
	}{
		{"approver cannot change leader", root.ID, event.Actor{Kind: event.ActorHuman, ID: "approver"}, "first", true},
		{"worker is not a leader", root.ID, event.Actor{Kind: event.ActorHuman, ID: "owner"}, "worker", true},
		{"unknown leader", root.ID, event.Actor{Kind: event.ActorHuman, ID: "owner"}, "foreign", true},
		{"child inherits leader", child.ID, event.Actor{Kind: event.ActorHuman, ID: "owner"}, "first", true},
		{"admin changes leader", root.ID, event.Actor{Kind: event.ActorHuman, ID: "admin"}, "first", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := pool.Update(ctx, tc.id, task.Update{Leader: tc.next}, tc.actor); (err != nil) != tc.fail {
				t.Fatalf("err=%v", err)
			}
		})
	}
	restored := task.New(storage, bus, event.NewID, groups)
	for _, id := range []event.ID{root.ID, child.ID} {
		got, err := restored.Get(ctx, id)
		if err != nil || got.Leader != "first" {
			t.Fatalf("card=%+v err=%v", got, err)
		}
	}
}
