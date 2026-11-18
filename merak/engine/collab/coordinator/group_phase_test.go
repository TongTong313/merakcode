package coordinator_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"testing"
	"time"
)

func TestAFailedDependencyStallsTheGoalAndNotifiesItsOwner(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	quiet := groupScript{name: "fake", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Recorded"} }}
	f := newCoordinator(t, dir, map[string]model.Provider{"fake": quiet})
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := f.createGroup(t, ctx, "owner", group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "approver", Name: "Reviewer", Kind: group.MemberHuman, Role: group.RoleApprover},
	}, []definition.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	prerequisite, err := f.coordinator.CreateTask(ctx, task.Card{Group: g.ID, Title: "Prerequisite", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	goal, err := f.coordinator.CreateTask(ctx, task.Card{Group: g.ID, Title: "Dependent goal", Workspace: "none", Deps: []event.ID{prerequisite.ID}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	if err := f.execution.UpdateTask(ctx, goal.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
		t.Fatal(err)
	}
	facts, stop := f.bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent}})
	defer stop()
	if err := f.tasks.Close(ctx, prerequisite.ID, task.Failed); err != nil {
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
			current, err := f.tasks.Get(ctx, goal.ID)
			if err != nil || current.Phase != task.PhaseStalled || current.PreviousPhase != task.PhaseDoing || current.Status != task.Blocked {
				t.Fatalf("goal=%+v err=%v", current, err)
			}
			return
		case <-ctx.Done():
			t.Fatal("failed dependency did not notify the owner")
		}
	}
}
