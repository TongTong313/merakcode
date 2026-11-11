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

// A task has no Leader of its own: the Leader of its group leads it, also after the group changes its Leader.
func TestTheLeaderOfTheGroupLeadsEveryTaskAlsoAfterItIsReplaced(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
		{ID: "first", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	if g.Leader != "first" {
		t.Fatalf("the only Leader agent was not made the Leader: %q", g.Leader)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	root, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Open(ctx, root.ID); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPriority(ctx, root.ID, "first", 2); err != nil {
		t.Fatalf("the Leader could not set a priority: %v", err)
	}
	if err := pool.SetPriority(ctx, root.ID, "worker", 3); err == nil {
		t.Fatal("a Worker changed a priority")
	}
	if _, err := groups.ReplaceLeader(ctx, g.ID, "owner", group.Member{ID: "second", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentLeader}); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPriority(ctx, root.ID, "first", 4); err == nil {
		t.Fatal("the former Leader still leads the task")
	}
	if err := pool.SetPriority(ctx, root.ID, "second", 4); err != nil {
		t.Fatalf("the new Leader does not lead the task: %v", err)
	}
	if err := pool.Update(ctx, root.ID, task.Update{Phase: task.PhaseDoing}, event.Actor{Kind: event.ActorAgent, ID: "second"}); err != nil {
		t.Fatalf("the new Leader cannot move the task: %v", err)
	}
}
