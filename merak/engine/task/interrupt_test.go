package task_test

import (
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestInterruptedClaimBlocksTaskAndCanResumeWithItsSession(t *testing.T) {
	ctx := t.Context()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Interrupt", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker}})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Interrupted task"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.OpenAndAssign(ctx, card.ID, "worker"); err != nil {
		t.Fatal(err)
	}
	claim, err := pool.Next(ctx, "worker")
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.Interrupt(ctx, claim.ID); err != nil {
		t.Fatal(err)
	}
	pool = task.New(storage, bus, event.NewID, groups)
	blocked, err := pool.Get(ctx, card.ID)
	if err != nil || blocked.Status != task.Blocked || blocked.Claims[0].Status != "interrupted" || blocked.Claims[0].Report != nil {
		t.Fatalf("card=%+v err=%v", blocked, err)
	}
	if err = pool.Interrupt(ctx, claim.ID); err != nil {
		t.Fatal(err)
	}
	if err = pool.Rework(ctx, claim.ID, "Resume after process failure"); err != nil {
		t.Fatal(err)
	}
	if err = pool.SetPhase(ctx, card.ID, blocked.PreviousPhase, event.Actor{Kind: event.ActorAgent, ID: "leader"}); err != nil {
		t.Fatal(err)
	}
	next, err := pool.Next(ctx, "worker")
	if err != nil || next.ID != claim.ID || next.Session != claim.Session {
		t.Fatalf("next=%+v err=%v", next, err)
	}
}
