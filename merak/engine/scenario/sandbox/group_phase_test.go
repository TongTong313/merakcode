package sandbox_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestCancellingAGoalStopsItsWorkerAndRunsTheNextGoal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	started, hold := make(chan struct{}), make(chan struct{})
	first := fake.Reply{Text: "Working", Hold: hold, Expect: func(model.Request) error { close(started); return nil }}
	second := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Next goal completed"})
	quiet := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, first, second)}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, worker := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, worker})
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
	if err := e.UpdateTask(ctx, next.ID, task.Update{Phase: task.PhaseDoing}, owner); err != nil {
		t.Fatal(err)
	}
	if err := e.UpdateTask(ctx, next.ID, task.Update{Phase: task.PhaseStalled}, owner); err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseCancelled}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Check the pending queue"}); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type == loop.TurnFinished && fact.Scope.Task == "" {
				current, err := e.Task(ctx, next.ID)
				if err != nil || current.Phase != task.PhaseStalled || current.Claims[0].Status != task.ClaimQueued {
					t.Fatalf("stalled goal started work: %+v %v", current, err)
				}
				if err := e.UpdateTask(ctx, next.ID, task.Update{Phase: task.PhaseDoing}, owner); err != nil {
					t.Fatal(err)
				}
			}
			if fact.Type == task.Reported && fact.Scope.Task == next.ID {
				cancelled, _ := e.Task(ctx, root.ID)
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

func TestCancellingAGoalInterruptsItsLeader(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	started := make(chan struct{})
	provider := fake.New(t, fake.Reply{Text: "Planning", Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }})
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	deps2.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
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
	if err := e.UpdateTask(ctx, card.ID, task.Update{Phase: task.PhaseCancelled}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil || outcome.Stop != loop.Cancelled {
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
	provider := fake.New(t, enginetest.IntegrationCall("set_phase", map[string]any{"phase": "doing"}), fake.Reply{Text: "Waiting for plan approval"}, fake.Reply{Text: "Approval received", Expect: func(model.Request) error { approved <- struct{}{}; return nil }})
	deps3 := enginetest.Deps(t)
	deps3.Workdir = dir
	deps3.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "leader-profile", "fake"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{PlanNeedsApproval: true}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
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
	current, err := e.Task(ctx, card.ID)
	if err != nil || current.Status == task.Done {
		t.Fatalf("plan approval completed the task: %+v %v", current, err)
	}
}

func TestIntegratedGoalAutomaticallyEntersReviewAndApprovalDeliversItsChildren(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	deps4 := enginetest.Deps(t)
	deps4.Workdir = dir
	deps4.Providers = map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified"}))}
	e, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := definition.DefaultMerakCode()
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Deliver findings", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
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
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
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
			goal, err := e.Task(ctx, root.ID)
			if err != nil || goal.Phase != task.PhaseDone || goal.Status != task.Done {
				t.Fatalf("goal=%+v err=%v", goal, err)
			}
			done, err := e.Task(ctx, child.ID)
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
	quiet := enginetest.GroupScript{ProviderName: "leader-model", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	deps5 := enginetest.Deps(t)
	deps5.Workdir = dir
	deps5.Providers = map[string]model.Provider{"leader-model": quiet, "worker-model": fake.New(t, enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified"}))}
	e, err := engine.New(deps5)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader-model"
	worker := definition.DefaultMerakCode()
	worker.ID, worker.Model.Provider = "worker-profile", "worker-model"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Review: &review}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: worker.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, worker})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	root, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Deliver findings", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
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
	if err := e.UpdateTask(ctx, root.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
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
				goal, _ := e.Task(ctx, root.ID)
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
