package engine_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"testing"
	"time"
)

func TestCancellingAGoalStopsItsWorkerAndRunsTheNextGoal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	started, hold := make(chan struct{}), make(chan struct{})
	first := fake.Reply{Text: "Working", Hold: hold, Expect: func(model.Request) error { close(started); return nil }}
	second := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Next goal completed"})
	quiet := groupScript{name: "leader-model", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, first, second)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, worker := profile.DefaultLeader(), profile.DefaultWorker()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	create := func(title string) task.Card {
		t.Helper()
		card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: title, Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
		if err != nil {
			t.Fatal(err)
		}
		return card
	}
	root := create("Cancel this goal")
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	next := create("Run this goal")
	owner := event.Actor{Kind: event.ActorHuman, ID: "owner"}
	if err := e.Tasks.SetPhase(ctx, next.ID, task.PhaseDoing, owner); err != nil {
		t.Fatal(err)
	}
	if err := e.Tasks.SetPhase(ctx, next.ID, task.PhaseStalled, owner); err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseCancelled, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Check the pending queue"}); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == loop.TurnFinished && fact.Scope.Task == "" {
				current, err := e.Tasks.Get(ctx, next.ID)
				if err != nil || current.Phase != task.PhaseStalled || current.Claims[0].Status != task.ClaimQueued {
					t.Fatalf("stalled goal started work: %+v %v", current, err)
				}
				if err := e.Tasks.SetPhase(ctx, next.ID, task.PhaseDoing, owner); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == task.Reported && fact.Scope.Task == next.ID {
				cancelled, _ := e.Tasks.Get(ctx, root.ID)
				if cancelled.Status != task.Cancelled || cancelled.Claims[0].Report != nil {
					t.Fatalf("cancelled=%+v", cancelled)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("cancellation did not release the worker queue")
		}
	}
}

func TestAFailedDependencyStallsTheGoalAndNotifiesItsOwner(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := groupScript{name: "fake", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": quiet}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "approver", Name: "Reviewer", Kind: group.MemberHuman, Role: group.RoleApprover},
	}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	prerequisite, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Prerequisite", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	goal, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Dependent goal", Workspace: "none", Deps: []event.ID{prerequisite.ID}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.Tasks.SetPhase(ctx, goal.ID, task.PhaseDoing, actor); err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent}})
	defer stop()
	if err := e.Tasks.Close(ctx, prerequisite.ID, task.Failed); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			notice, _ := event.Decode[group.Notice](fact)
			if fact.Scope.Task != goal.ID || notice.Kind != "blocked" {
				continue
			}
			if len(notice.To) != 1 || notice.To[0] != "owner" {
				t.Fatalf("recipients=%v", notice.To)
			}
			current, err := e.Tasks.Get(ctx, goal.ID)
			if err != nil || current.Phase != task.PhaseStalled || current.PreviousPhase != task.PhaseDoing || current.Status != task.Blocked {
				t.Fatalf("goal=%+v err=%v", current, err)
			}
			return
		case <-ctx.Done():
			t.Fatal("failed dependency did not notify the owner")
		}
	}
}

func TestCancellingAGoalInterruptsItsLeader(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	started := make(chan struct{})
	provider := fake.New(t, fake.Reply{Text: "Planning", Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }})
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Cancel while planning", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Tasks.SetPhase(ctx, card.ID, task.PhaseCancelled, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil || outcome.Stop != loop.Cancelled || fact.Scope.Task != card.ID {
			t.Fatalf("outcome=%+v err=%v", outcome, err)
		}
	case <-ctx.Done():
		t.Fatal("cancelled goal left its Leader running")
	}
}

func TestTheLeaderRequestsAPlanCheckpointAndHumanApprovalStartsDoing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	approved := make(chan struct{}, 1)
	provider := fake.New(t, integrationCall("set_phase", map[string]any{"phase": "doing"}), fake.Reply{Text: "Waiting for plan approval"}, fake.Reply{Text: "Approval received", Expect: func(model.Request) error { approved <- struct{}{}; return nil }})
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "leader-profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader", Settings: group.Settings{PlanNeedsApproval: true}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Plan", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	noticed, finished := false, false
	for !noticed || !finished {
		select {
		case fact := <-facts:
			if fact.Type == group.NoticeSent {
				notice, _ := event.Decode[group.Notice](fact)
				if notice.Kind == "plan" && len(notice.To) == 1 && notice.To[0] == "owner" {
					noticed = true
				}
			}
			if fact.Type == loop.TurnFinished {
				finished = true
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := e.ReviewTask(ctx, card.ID, "owner", "approve", ""); err != nil {
		t.Fatal(err)
	}
	select {
	case <-approved:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	view, err := e.GroupState(ctx, g.ID)
	if err != nil || len(view.Goals) != 1 || view.Goals[0].Phase != task.PhaseDoing {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	current, err := e.Tasks.Get(ctx, card.ID)
	if err != nil || current.Status == task.Done {
		t.Fatalf("plan approval completed the task: %+v %v", current, err)
	}
}

func TestIntegratedGoalAutomaticallyEntersReviewAndApprovalDeliversItsChildren(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := groupScript{name: "leader-model", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified"}))}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := profile.DefaultWorker()
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Deliver findings", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseDoing, actor); err != nil {
		t.Fatal(err)
	}
	child, err := e.CreateTask(ctx, task.Card{Group: g.ID, Parent: root.ID, Title: "Research", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.AssignTask(ctx, child.ID, "owner", "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	reported := false
	for !reported {
		select {
		case fact := <-facts:
			reported = fact.Type == task.Reported && fact.Scope.Task == child.ID
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseIntegrating, actor); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type != group.NoticeSent || fact.Scope.Task != root.ID {
				continue
			}
			notice, _ := event.Decode[group.Notice](fact)
			if notice.Kind != "review" {
				continue
			}
			if err := e.ReviewTask(ctx, root.ID, "owner", "approve", ""); err != nil {
				t.Fatal(err)
			}
			goal, err := e.Tasks.Get(ctx, root.ID)
			if err != nil || goal.Phase != task.PhaseDone || goal.Status != task.Done {
				t.Fatalf("goal=%+v err=%v", goal, err)
			}
			done, err := e.Tasks.Get(ctx, child.ID)
			if err != nil || done.Status != task.Done {
				t.Fatalf("child=%+v err=%v", done, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestAGroupCanDisableTheFinalHumanReviewCheckpoint(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	review := false
	quiet := groupScript{name: "leader-model", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified"}))}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := profile.DefaultWorker()
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader", Settings: group.Settings{Review: &review}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Deliver findings", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseDoing, actor); err != nil {
		t.Fatal(err)
	}
	reported := false
	for !reported {
		select {
		case fact := <-facts:
			reported = fact.Type == task.Reported
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := e.Tasks.SetPhase(ctx, root.ID, task.PhaseIntegrating, actor); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == group.NoticeSent {
				notice, _ := event.Decode[group.Notice](fact)
				if notice.Kind == "review" {
					t.Fatal("disabled checkpoint sent an actionable notice")
				}
			}
			if fact.Type == task.Closed && fact.Scope.Task == root.ID {
				goal, _ := e.Tasks.Get(ctx, root.ID)
				if goal.Phase != task.PhaseDone {
					t.Fatalf("phase=%s", goal.Phase)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
