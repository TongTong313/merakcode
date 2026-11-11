package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestLeaderThreadRecoveryKeepsItsSessionAndConversation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	disk := memory.New()
	e, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Original agreement: preserve the API"})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []agent.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	goal, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	var id event.ID
	select {
	case fact := <-facts:
		id = fact.Scope.Session
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	e.Close()
	resumed := fake.New(t, fake.Reply{Text: "Recovered", Expect: func(req model.Request) error {
		if !strings.Contains(fmt.Sprint(req.Messages), "Original agreement: preserve the API") {
			return fmt.Errorf("Leader conversation was replaced after restart")
		}
		return nil
	}})
	restarted, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": resumed}})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if err := restarted.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	facts, stopAgain := restarted.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stopAgain()
	if _, err := restarted.SayGroup(ctx, g.ID, goal.ID, "owner", group.Message{Text: "Continue after restart", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		if fact.Scope.Session != id {
			t.Fatalf("session=%s want=%s", fact.Scope.Session, id)
		}
	case <-ctx.Done():
		t.Fatal("recovered group did not resume its task thread")
	}
	created, err := disk.Find(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{session.Created}})
	if err != nil || len(created) != 1 {
		t.Fatalf("sessions=%d err=%v", len(created), err)
	}
}

func TestReplacingTheLeaderHandsOverTheGroupThread(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(map[bool]string{false: "live", true: "restart"}[restart], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			dir, disk := t.TempDir(), memory.New()
			provider := fake.New(t, fake.Reply{Text: "Keep the public API"}, fake.Reply{Text: "Keep the public API", Expect: func(req model.Request) error {
				if !strings.Contains(req.System, "handover summary") {
					return fmt.Errorf("missing handover request")
				}
				return nil
			}}, fake.Reply{Text: "Inherited", Expect: func(req model.Request) error {
				if !strings.Contains(fmt.Sprint(req.Messages), "## Handover") || !strings.Contains(fmt.Sprint(req.Messages), "Keep the public API") {
					return fmt.Errorf("missing handover context")
				}
				return nil
			}})
			e, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p, next := agent.DefaultLeader(), agent.DefaultLeader()
			p.ID, p.Model.Provider = "profile", "fake"
			next.ID, next.Name, next.Model.Provider = "next-profile", "Second", "fake"
			g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Handover", Leader: "first", Project: group.Project{Directory: dir}}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "first", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
			}, []agent.Agent{p, next})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
			defer stop()
			if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Remember this agreement"}); err != nil {
				t.Fatal(err)
			}
			var previous event.Event
			select {
			case previous = <-facts:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if restart {
				e.Close()
				e, err = engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
				if err != nil {
					t.Fatal(err)
				}
				defer e.Close()
				facts, stop = e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
				defer stop()
			}
			id := next.ID
			if _, err := e.UpdateGroup(ctx, g.ID, "owner", group.Update{Leader: &id}); err != nil {
				t.Fatal(err)
			}
			if restart {
				if err := e.Recover(ctx); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case fact := <-facts:
				if fact.Actor.ID == "first" || fact.Scope.Task != "" || fact.Scope.Session == previous.Scope.Session {
					t.Fatalf("successor=%+v", fact)
				}
			case <-ctx.Done():
				t.Fatal("group leader change did not complete")
			}
		})
	}
}

func TestRecoveryCompletesALeaderChangePersistedBeforeTheHandover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir, disk := t.TempDir(), memory.New()
	e, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Keep the API stable"})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p, next := agent.DefaultLeader(), agent.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	next.ID, next.Name, next.Model.Provider = "next-profile", "Second", "fake"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "a"}, []group.Member{
		{ID: "a", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []agent.Agent{p, next})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if _, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}); err != nil {
		t.Fatal(err)
	}
	var oldID event.ID
	select {
	case fact := <-facts:
		oldID = fact.Scope.Session
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	e.Close()
	provider := fake.New(t,
		fake.Reply{Text: "Keep the API stable", Expect: func(req model.Request) error {
			if !strings.Contains(req.System, "handover summary") || !strings.Contains(fmt.Sprint(req.Messages), "Keep the API stable") {
				return fmt.Errorf("handover did not summarize the previous thread")
			}
			return nil
		}},
		fake.Reply{Text: "Inherited", Expect: func(req model.Request) error {
			if !strings.Contains(fmt.Sprint(req.Messages), "## Handover") {
				return fmt.Errorf("recovered leader did not receive the handover")
			}
			return nil
		}},
	)
	restarted, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	nextID := next.ID
	if _, err := restarted.UpdateGroup(ctx, g.ID, "owner", group.Update{Leader: &nextID}); err != nil {
		t.Fatal(err)
	}
	facts, stopAgain := restarted.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stopAgain()
	if err := restarted.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		if fact.Actor.ID == "a" || fact.Scope.Session == oldID {
			t.Fatalf("recovery used the old leader: %+v", fact)
		}
	case <-ctx.Done():
		t.Fatal("persisted Leader change did not resume handover")
	}
}
