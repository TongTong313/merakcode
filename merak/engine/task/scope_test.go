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

func TestCollaboratorsRequireDisjointScopesWithinTaskAreas(t *testing.T) {
	for _, tc := range []struct {
		name     string
		scope    []string
		rejected bool
	}{
		{"separate subtree", []string{"src/web"}, false},
		{"same subtree", []string{"src/api"}, true},
		{"descendant", []string{"src/api/handler.go"}, true},
		{"ancestor", []string{"src"}, true},
		{"missing scope", nil, true},
		{"outside task", []string{"docs"}, true},
		{"relative escape", []string{"../other"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			groups := group.New(storage, bus, event.NewID)
			g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader", Settings: group.Settings{Review: new(false)}}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "a", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
				{ID: "b", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
			})
			if err != nil {
				t.Fatal(err)
			}
			pool := task.New(storage, bus, event.NewID, groups)
			card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Implement API and UI", Areas: []string{"src"}})
			if err != nil {
				t.Fatal(err)
			}
			if err := pool.Open(ctx, card.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Assign(ctx, card.ID, "a", task.RoleOwner, []string{"src/api"}); err != nil {
				t.Fatal(err)
			}
			first, err := pool.Next(ctx, "a")
			if err != nil {
				t.Fatal(err)
			}
			_, err = pool.Assign(ctx, card.ID, "b", task.RoleCollaborator, tc.scope)
			if (err != nil) != tc.rejected {
				t.Fatalf("assignment err=%v rejected=%v", err, tc.rejected)
			}
			if tc.rejected {
				return
			}
			second, err := pool.Next(ctx, "b")
			if err != nil {
				t.Fatal(err)
			}
			if err := pool.Submit(ctx, task.Report{Claim: first.ID, Verdict: task.VerdictDone, Summary: "API complete"}); err != nil {
				t.Fatal(err)
			}
			current, _ := pool.Get(ctx, card.ID)
			if current.Status != task.Running {
				t.Fatalf("second worker still active: %s", current.Status)
			}
			if err := pool.Close(ctx, card.ID, task.Done); err == nil {
				t.Fatal("task closed before collaborator reported")
			}
			if err := pool.Submit(ctx, task.Report{Claim: second.ID, Verdict: task.VerdictDone, Summary: "UI complete"}); err != nil {
				t.Fatal(err)
			}
			for _, phase := range []task.Phase{task.PhaseDoing, task.PhaseIntegrating, task.PhaseReview} {
				if err := pool.SetPhase(ctx, card.ID, phase, event.Actor{Kind: event.ActorAgent, ID: "leader"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := pool.Close(ctx, card.ID, task.Done); err != nil {
				t.Fatal(err)
			}
		})
	}
}
