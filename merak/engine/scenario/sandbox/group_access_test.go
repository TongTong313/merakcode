package sandbox_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestObserverCannotMutateGroup(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"quiet": enginetest.GroupScript{ProviderName: "quiet", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := definition.DefaultMerakCode()
	p.ID, p.Model.Provider = "leader-profile", "quiet"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Roles", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
	}, []definition.Agent{p})
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
	if _, err := e.AddGroupMember(ctx, g.ID, "observer", group.Member{Name: "Unauthorized", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-merakcode"}); err == nil {
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
	var pending atomic.Pointer[event.ID]
	provider := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		id := pending.Load()
		if id != nil {
			messages, _ := json.Marshal(req.Messages)
			if strings.Contains(string(messages), "Assign the private task "+string(*id)) && pending.CompareAndSwap(id, nil) {
				input, _ := json.Marshal(map[string]any{"task": *id, "member": "worker", "role": task.RoleOwner})
				return fake.Reply{Calls: []model.ToolCall{{ID: string(*id), Name: "assign_task", Input: input}}}
			}
		}
		return fake.Reply{Text: "Recorded"}
	}}
	deps2 := enginetest.Deps(t)
	deps2.Workdir = t.TempDir()
	deps2.Providers = map[string]model.Provider{"leader": provider}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	if _, err := e.SaveAgent(ctx, "owner", lead); err != nil {
		t.Fatal(err)
	}
	p := definition.DefaultMerakCode()
	p.ID = "private"
	if err := json.Unmarshal([]byte(`{"shared":false}`), &p); err != nil {
		t.Fatal(err)
	}
	if _, err := e.SaveAgent(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Private", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "other", Name: "Other", Kind: group.MemberHuman, Role: group.RoleMember},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID, Owner: "owner"},
	})
	if err != nil {
		t.Fatal(err)
	}
	assignAsLeader := func(card task.Card) error {
		completed, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{tool.Completed}})
		defer stop()
		pending.Store(&card.ID)
		if _, err := e.SayGroup(ctx, g.ID, card.ID, "owner", group.Message{Text: "Assign the private task " + string(card.ID)}); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case fact := <-completed:
				result, err := event.Decode[tool.Completion](fact)
				if err != nil {
					t.Fatal(err)
				}
				if result.Name != "assign_task" || result.CallID != string(card.ID) {
					continue
				}
				if result.IsError {
					return errors.New("Leader assignment was rejected")
				}
				return nil
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	for _, actor := range []event.Actor{{Kind: event.ActorHuman, ID: "other"}, {Kind: event.ActorAgent, ID: "leader"}, {Kind: event.ActorHuman, ID: "owner"}} {
		card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Private assignment", Workspace: "none"})
		if err != nil {
			t.Fatal(err)
		}
		if actor.Kind == event.ActorAgent {
			err = assignAsLeader(card)
		} else {
			_, err = e.AssignTask(ctx, card.ID, actor.ID, "worker", task.RoleOwner, nil)
		}
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
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Shared assignment", Workspace: "none"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.AssignTask(ctx, card.ID, "other", "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
}
