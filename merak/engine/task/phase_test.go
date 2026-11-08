package task_test

import (
	"context"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"testing"
	"time"
)

func TestStalledGoalsPauseQueuedClaimsAndCancellationClosesTheWholeSubtree(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "a", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "b", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	root, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Open(ctx, root.ID); err != nil {
		t.Fatal(err)
	}
	owner := event.Actor{Kind: event.ActorHuman, ID: "owner"}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseDoing, owner); err != nil {
		t.Fatal(err)
	}
	var children []task.Card
	for _, member := range []event.ID{"a", "b"} {
		child, err := pool.Create(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: string(member)})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.OpenAndAssign(ctx, child.ID, member); err != nil {
			t.Fatal(err)
		}
		children = append(children, child)
	}
	active, err := pool.Next(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseStalled, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Next(ctx, "b"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("stalled goal dispatched a queued claim: %v", err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseDoing, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Next(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseCancelled, owner); err != nil {
		t.Fatal(err)
	}
	for _, child := range children {
		got, err := pool.Get(ctx, child.ID)
		if err != nil || got.Status != task.Cancelled || got.Claims[0].Status != task.ClaimAbandoned {
			t.Fatalf("cancelled child=%+v err=%v", got, err)
		}
	}
	if err := pool.Submit(ctx, task.Report{Claim: active.ID, Verdict: task.VerdictDone, Summary: "Late report"}); err == nil {
		t.Fatal("late report revived a cancelled claim")
	}
	closed, err := storage.Find(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Closed}})
	if err != nil || len(closed) != 3 {
		t.Fatalf("closed=%d err=%v", len(closed), err)
	}
}

func TestTopLevelPhasesPersistAndRestoreThePhaseBeforeAStall(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	root, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := pool.Create(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Work"})
	if err != nil {
		t.Fatal(err)
	}
	if root.Phase != task.PhasePlanning || child.Phase != "" {
		t.Fatalf("root=%s child=%s", root.Phase, child.Phase)
	}
	lead := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	owner := event.Actor{Kind: event.ActorHuman, ID: "owner"}
	for _, tc := range []struct {
		name  string
		id    event.ID
		phase task.Phase
		actor event.Actor
		fail  bool
	}{
		{"child has no phase", child.ID, task.PhaseDoing, lead, true},
		{"cannot skip to review", root.ID, task.PhaseReview, lead, true},
		{"start doing", root.ID, task.PhaseDoing, lead, false},
		{"stall", root.ID, task.PhaseStalled, lead, false},
		{"cannot resume elsewhere", root.ID, task.PhaseIntegrating, owner, true},
		{"resume", root.ID, task.PhaseDoing, owner, false},
		{"leader cannot cancel", root.ID, task.PhaseCancelled, lead, true},
		{"owner cancels", root.ID, task.PhaseCancelled, owner, false},
		{"cancel is final", root.ID, task.PhasePlanning, owner, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := pool.SetPhase(ctx, tc.id, tc.phase, tc.actor); (err != nil) != tc.fail {
				t.Fatalf("phase=%s err=%v", tc.phase, err)
			}
		})
	}
	restored := task.New(storage, bus, event.NewID, groups)
	got, err := restored.Get(ctx, root.ID)
	if err != nil || got.Phase != task.PhaseCancelled || got.Status != task.Cancelled {
		t.Fatalf("card=%+v err=%v", got, err)
	}
	facts, err := storage.Find(ctx, store.Query{Scope: event.Scope{Task: root.ID}, Types: []event.Type{task.PhaseChanged}})
	if err != nil || len(facts) != 4 {
		t.Fatalf("phase events=%d err=%v", len(facts), err)
	}
}

func TestPlanningWaitsForTheConfiguredHumanCheckpoint(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader", Settings: group.Settings{PlanNeedsApproval: true}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Open(ctx, card.ID); err != nil {
		t.Fatal(err)
	}
	lead := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := pool.SetPhase(ctx, card.ID, task.PhaseDoing, lead); err != nil {
		t.Fatal(err)
	}
	waiting, _ := pool.Get(ctx, card.ID)
	if waiting.Phase != task.PhasePlanning || !waiting.PlanPending {
		t.Fatalf("checkpoint=%+v", waiting)
	}
	if _, err := pool.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err == nil {
		t.Fatal("worker was assigned before the plan was approved")
	}
	if err := pool.Review(ctx, card.ID, task.ReviewResult{Human: "owner", Decision: "approve"}); err != nil {
		t.Fatal(err)
	}
	doing, _ := pool.Get(ctx, card.ID)
	if doing.Phase != task.PhaseDoing || doing.PlanPending || doing.LastReview == nil || doing.LastReview.Phase != task.PhasePlanning {
		t.Fatalf("approved=%+v", doing)
	}
	if _, err := pool.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, card.ID, task.PhasePlanning, lead); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Next(ctx, "worker"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("queued work bypassed replanning: %v", err)
	}
	if err := pool.SetPhase(ctx, card.ID, task.PhaseDoing, lead); err != nil {
		t.Fatal(err)
	}
	if err := pool.Review(ctx, card.ID, task.ReviewResult{Human: "owner", Decision: "replan", Feedback: "Change the goal"}); err != nil {
		t.Fatal(err)
	}
	revised, _ := pool.Get(ctx, card.ID)
	if revised.Phase != task.PhasePlanning || revised.PlanPending {
		t.Fatalf("revised=%+v", revised)
	}
	if _, err := pool.Next(ctx, "worker"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("queued work bypassed a rejected plan: %v", err)
	}
	if err := pool.SetPhase(ctx, card.ID, task.PhaseDoing, lead); err != nil {
		t.Fatal(err)
	}
	if err := pool.Review(ctx, card.ID, task.ReviewResult{Human: "owner", Decision: "approve"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Next(ctx, "worker"); err != nil {
		t.Fatalf("approved plan did not resume queued work: %v", err)
	}
}

func TestIntegrationRequiresReportsAndPublishedArtifactsBeforeHumanDelivery(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	root, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := pool.Create(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Write guide", Workspace: "folder", Review: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []event.ID{root.ID, child.ID} {
		if err := pool.Open(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	lead := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseDoing, lead); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseIntegrating, lead); err == nil {
		t.Fatal("unreported work entered integration")
	}
	if _, err := pool.Assign(ctx, child.ID, "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	claim, err := pool.Next(ctx, "worker")
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Submit(ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictDone, Summary: "Ready", Artifacts: []task.Artifact{{Path: "guide.md"}}}); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseIntegrating, lead); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseReview, lead); err == nil {
		t.Fatal("unpublished work entered review")
	}
	if err := pool.MarkPublished(ctx, claim.ID, []event.ID{"artifact"}); err != nil {
		t.Fatal(err)
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseReview, lead); err == nil {
		t.Fatal("goal review bypassed the required child review")
	}
	if err := pool.Review(ctx, child.ID, task.ReviewResult{Human: "owner", Decision: "approve"}); err != nil {
		t.Fatal(err)
	}
	if err := pool.Close(ctx, child.ID, task.Done); err != nil {
		t.Fatal(err)
	}
	if err := pool.Close(ctx, root.ID, task.Done); err == nil {
		t.Fatal("integration bypassed the review phase")
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseReview, lead); err != nil {
		t.Fatal(err)
	}
	if err := pool.Close(ctx, root.ID, task.Done); err == nil {
		t.Fatal("default human review was skipped")
	}
	if err := pool.SetPhase(ctx, root.ID, task.PhaseDone, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err == nil {
		t.Fatal("phase change bypassed the review decision")
	}
	if err := pool.Review(ctx, root.ID, task.ReviewResult{Human: "owner", Decision: "approve"}); err != nil {
		t.Fatal(err)
	}
	if err := pool.Close(ctx, root.ID, task.Done); err != nil {
		t.Fatal(err)
	}
	finished, err := pool.Get(ctx, root.ID)
	if err != nil || finished.Phase != task.PhaseDone || finished.Status != task.Done {
		t.Fatalf("finished=%+v err=%v", finished, err)
	}
}

func TestGoalReviewReturnsOriginalClaimsToDoingOrReturnsToPlanning(t *testing.T) {
	for _, decision := range []string{"rework", "replan"} {
		t.Run(decision, func(t *testing.T) {
			ctx := context.Background()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			groups := group.New(storage, bus, event.NewID)
			g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
			})
			if err != nil {
				t.Fatal(err)
			}
			pool := task.New(storage, bus, event.NewID, groups)
			root, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
			if err != nil {
				t.Fatal(err)
			}
			child, err := pool.Create(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Write guide", Workspace: "worktree"})
			if err != nil {
				t.Fatal(err)
			}
			for _, id := range []event.ID{root.ID, child.ID} {
				if err := pool.Open(ctx, id); err != nil {
					t.Fatal(err)
				}
			}
			lead := event.Actor{Kind: event.ActorAgent, ID: "leader"}
			if err := pool.SetPhase(ctx, root.ID, task.PhaseDoing, lead); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Assign(ctx, child.ID, "worker", task.RoleOwner, nil); err != nil {
				t.Fatal(err)
			}
			claim, err := pool.Next(ctx, "worker")
			if err != nil {
				t.Fatal(err)
			}
			if err := pool.BindWorkspace(ctx, claim.ID, "workspace"); err != nil {
				t.Fatal(err)
			}
			if err := pool.Submit(ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictDone, Summary: "Ready"}); err != nil {
				t.Fatal(err)
			}
			if err := pool.SetPhase(ctx, root.ID, task.PhaseIntegrating, lead); err != nil {
				t.Fatal(err)
			}
			if err := pool.MarkIntegrated(ctx, claim.ID, "merged-head"); err != nil {
				t.Fatal(err)
			}
			if err := pool.Close(ctx, child.ID, task.Done); err != nil {
				t.Fatal(err)
			}
			if err := pool.SetPhase(ctx, root.ID, task.PhaseReview, lead); err != nil {
				t.Fatal(err)
			}
			if err := pool.Review(ctx, root.ID, task.ReviewResult{Human: "owner", Decision: decision, Feedback: "Revise the result"}); err != nil {
				t.Fatal(err)
			}
			changed, _ := pool.Get(ctx, root.ID)
			if decision == "replan" {
				if changed.Phase != task.PhasePlanning {
					t.Fatalf("phase=%s", changed.Phase)
				}
				return
			}
			if changed.Phase != task.PhaseDoing {
				t.Fatalf("phase=%s", changed.Phase)
			}
			resumed, err := pool.Next(ctx, "worker")
			if err != nil || resumed.ID != claim.ID || resumed.Session != claim.Session || resumed.Workspace != "workspace" || resumed.Integrated != "" || resumed.Feedback != "Revise the result" {
				t.Fatalf("resumed=%+v err=%v", resumed, err)
			}
		})
	}
}
