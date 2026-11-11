package engine_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestObserverCannotMutateGroup(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"quiet": groupScript{name: "quiet", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultLeader()
	p.ID, p.Model.Provider = "leader-profile", "quiet"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Roles", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
	}, []agent.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	before, err := e.ReadEvents(ctx, event.Stream("group:"+g.ID), 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "observer", group.Message{Text: "Unauthorized"}); err == nil {
		t.Error("observer spoke")
	}
	if _, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Unauthorized", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "observer"}}); err == nil {
		t.Error("observer created a task")
	}
	if _, err := e.AddGroupMember(ctx, g.ID, "observer", group.Member{Name: "Unauthorized", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-worker"}); err == nil {
		t.Error("observer registered a member")
	}
	after, err := e.ReadEvents(ctx, event.Stream("group:"+g.ID), 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("rejected operations wrote events: before=%d after=%d", len(before), len(after))
	}
}

func TestPrivateMemberAcceptsOnlyItsOwnersAssignments(t *testing.T) {
	ctx := t.Context()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultWorker()
	p.ID = "private"
	if err := json.Unmarshal([]byte(`{"shared":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Private", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "other", Name: "Other", Kind: group.MemberHuman, Role: group.RoleMember},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID, Owner: "owner"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range []event.Actor{{Kind: event.ActorHuman, ID: "other"}, {Kind: event.ActorAgent, ID: "leader"}, {Kind: event.ActorHuman, ID: "owner"}} {
		card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "Private assignment"})
		if err != nil {
			t.Fatal(err)
		}
		if err := e.Tasks.Open(ctx, card.ID); err != nil {
			t.Fatal(err)
		}
		_, err = e.Tasks.AssignAs(ctx, card.ID, "worker", task.RoleOwner, nil, actor)
		if (err == nil) != (actor.ID == "owner") {
			t.Fatalf("actor=%+v error=%v", actor, err)
		}
	}
	if err := json.Unmarshal([]byte(`{"shared":true}`), &p); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "Shared assignment"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Tasks.Open(ctx, card.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.AssignTask(ctx, card.ID, "other", "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
}
