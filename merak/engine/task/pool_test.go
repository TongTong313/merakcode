package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestTaskLifecycleQueuesBusyMembersAndRejectsChildren(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader", Settings: group.Settings{Review: new(false)}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	first, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "First", CreatedBy: event.Actor{Kind: event.ActorHuman}})
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != task.Draft || first.Leader != "leader" {
		t.Fatalf("card=%+v", first)
	}
	if err := pool.Open(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []event.ID{"", "child-session", "leader"} {
		if _, err := pool.Assign(ctx, first.ID, id, task.RoleOwner, nil); !errors.Is(err, task.ErrNotMember) {
			t.Fatalf("member=%q err=%v", id, err)
		}
	}
	claim, err := pool.Assign(ctx, first.ID, "worker", task.RoleOwner, nil)
	if err != nil || claim.Session != "" || claim.Status != task.ClaimQueued {
		t.Fatalf("claim=%+v err=%v", claim, err)
	}
	active, err := pool.Next(ctx, "worker")
	if err != nil || active.ID != claim.ID || active.Session == "" || active.Status != task.ClaimActive {
		t.Fatalf("active=%+v err=%v", active, err)
	}
	second, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Second"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Open(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	queued, err := pool.Assign(ctx, second.ID, "worker", task.RoleOwner, nil)
	if err != nil || queued.Status != task.ClaimQueued {
		t.Fatalf("queued=%+v err=%v", queued, err)
	}
	if _, err := pool.Next(ctx, "worker"); !errors.Is(err, task.ErrBusy) {
		t.Fatalf("second claim ran concurrently: %v", err)
	}
	if err := pool.Submit(ctx, task.Report{Claim: active.ID, Verdict: task.VerdictDone, Summary: "Verified first"}); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []task.Phase{task.PhaseDoing, task.PhaseIntegrating, task.PhaseReview} {
		if err := pool.SetPhase(ctx, first.ID, phase, event.Actor{Kind: event.ActorAgent, ID: "leader"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.Close(ctx, first.ID, task.Done); err != nil {
		t.Fatal(err)
	}
	pool = task.New(storage, bus, event.NewID, groups)
	finished, err := pool.Get(ctx, first.ID)
	if err != nil || finished.Status != task.Done || finished.Claims[0].Report.Summary != "Verified first" {
		t.Fatalf("restored=%+v err=%v", finished, err)
	}
	next, err := pool.Next(ctx, "worker")
	if err != nil || next.ID != queued.ID {
		t.Fatalf("next=%+v err=%v", next, err)
	}
	facts, err := storage.Find(ctx, store.Query{Scope: event.Scope{Task: first.ID}})
	if err != nil {
		t.Fatal(err)
	}
	var types []event.Type
	for _, fact := range facts {
		types = append(types, fact.Type)
	}
	if !reflect.DeepEqual(types, []event.Type{"task.created", "task.opened", "task.queued", "task.started", "task.reported", "phase.changed", "phase.changed", "phase.changed", "phase.changed", "task.closed"}) {
		t.Fatalf("events=%v", types)
	}
}
