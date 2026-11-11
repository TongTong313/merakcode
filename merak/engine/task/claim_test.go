package task_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestAMemberClaimsATaskOfItsOwnGroupAsItself(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	members := []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "writer", Name: "Writer", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "tester", Name: "Tester", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	}
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, members)
	if err != nil {
		t.Fatal(err)
	}
	other, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Other", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, members)
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	open := func(groupID event.ID, title string) task.Card {
		t.Helper()
		card, err := pool.Create(ctx, task.Card{Group: groupID, Title: title, CreatedBy: event.Actor{Kind: event.ActorAgent, ID: "leader"}})
		if err != nil {
			t.Fatal(err)
		}
		if err := pool.Open(ctx, card.ID); err != nil {
			t.Fatal(err)
		}
		return card
	}
	card := open(g.ID, "Write the page")

	claim, err := pool.Claim(ctx, card.ID, g.ID, "writer", []string{"src/"})
	if err != nil || claim.Member != "writer" || claim.Role != task.RoleOwner || claim.Status != task.ClaimQueued {
		t.Fatalf("claim=%+v err=%v", claim, err)
	}
	facts, err := storage.Find(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.QueuedEvent}})
	if err != nil || len(facts) != 1 || facts[0].Actor.Kind != event.ActorAgent || facts[0].Actor.ID != "writer" {
		t.Fatalf("the claim is attributed to %+v: %v", facts, err)
	}
	if _, err := pool.Claim(ctx, card.ID, g.ID, "tester", nil); err == nil {
		t.Fatal("a second member took a task that already has an owner without a scope")
	}
	if _, err := pool.Claim(ctx, card.ID, g.ID, "tester", []string{"docs/"}); err != nil {
		t.Fatalf("a collaborator with a scope was refused: %v", err)
	}
	if _, err := pool.Claim(ctx, open(other.ID, "Elsewhere").ID, g.ID, "writer", nil); err == nil {
		t.Fatal("a member claimed a task of another group")
	}
	closed := open(g.ID, "Closed work")
	if err := pool.Close(ctx, closed.ID, task.Cancelled); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Claim(ctx, closed.ID, g.ID, "writer", nil); err == nil {
		t.Fatal("a member claimed a cancelled task")
	}
	if _, err := pool.Claim(ctx, card.ID, g.ID, "leader", nil); err == nil {
		t.Fatal("the Leader claimed a task as a Worker")
	}
}
