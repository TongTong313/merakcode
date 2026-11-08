package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
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

func TestRecoveryCompletesALeaderChangePersistedBeforeTheHandover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir, disk := t.TempDir(), memory.New()
	e, err := engine.New(engine.Deps{Store: disk, Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Keep the API stable"})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "a"}, []group.Member{
		{ID: "a", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID},
		{ID: "b", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	goal, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Goal", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
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
	if err := restarted.Tasks.Update(ctx, goal.ID, task.Update{Leader: "b"}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
		t.Fatal(err)
	}
	facts, stopAgain := restarted.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stopAgain()
	if err := restarted.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		if fact.Actor.ID != "b" || fact.Scope.Session == oldID {
			t.Fatalf("recovery used the old leader: %+v", fact)
		}
	case <-ctx.Done():
		t.Fatal("persisted Leader change did not resume handover")
	}
}

func TestTaskLeaderHandoverSeedsANewSessionWithoutInterruptingAnotherThread(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	otherStarted, holdOther, inherited := make(chan struct{}, 1), make(chan struct{}), make(chan struct{}, 1)
	summaryStarted, releaseSummary, otherAnswered := make(chan struct{}), make(chan struct{}), make(chan struct{}, 1)
	var handovers atomic.Int32
	var goal task.Card
	first := groupScript{name: "first", test: t, reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError {
					t.Errorf("leader change failed: %+v", part.ToolResult)
				}
				return fake.Reply{Text: "Leader change requested"}
			}
			if strings.Contains(part.Text, "Replace task leader") {
				return integrationCall("set_task_leader", map[string]any{"task": goal.ID, "leader": "a"})
			}
		}
		text := fmt.Sprint(req.Messages)
		if strings.Contains(text, "Urgent unrelated question") {
			otherAnswered <- struct{}{}
			return fake.Reply{Text: "Independent answer"}
		}
		if strings.Contains(text, "## Handover") {
			for _, spec := range req.Tools {
				if spec.Name == "set_task_leader" {
					t.Error("task thread received group-only leader management")
				}
			}
			if !strings.Contains(text, "Keep the API stable") || !strings.Contains(text, "Migrating API") || !strings.Contains(text, "## Members") {
				t.Error("new leader lost the summary, task card or group state")
			}
			inherited <- struct{}{}
			return fake.Reply{Text: "Continuing the inherited plan"}
		}
		otherStarted <- struct{}{}
		return fake.Reply{Text: "Other goal continues", Hold: holdOther}
	}}
	second := groupScript{name: "second", test: t, reply: func(req model.Request) fake.Reply {
		if strings.Contains(req.System, "handover summary") {
			handovers.Add(1)
			if len(req.Tools) != 0 || req.MaxTokens > 512 || !strings.Contains(fmt.Sprint(req.Messages), "Original plan") {
				t.Error("handover did not use a bounded summary of the old conversation")
			}
			close(summaryStarted)
			return fake.Reply{Text: "Keep the API stable", Hold: releaseSummary}
		}
		if !strings.Contains(fmt.Sprint(req.Messages), "Migrating API") {
			t.Error("task ignored its explicit leader")
		}
		return fake.Reply{Text: "Original plan"}
	}}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"first": first, "second": second}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	a, b := profile.DefaultLeader(), profile.DefaultLeader()
	a.ID, a.Model.Provider, b.ID, b.Model.Provider = "profile-a", "first", "profile-b", "second"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "a"}, []group.Member{
		{ID: "a", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: a.ID},
		{ID: "b", Name: "Second", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: b.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{a, b})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	other, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Independent goal", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-otherStarted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	finished, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID, Task: other.ID}, Types: []event.Type{loop.TurnFinished}})
	if err != nil || len(finished) != 0 {
		t.Fatalf("recovery interrupted an active group thread: %+v %v", finished, err)
	}
	goal, err = e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Migrating API", Leader: "b", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	var oldSession event.ID
	for oldSession == "" {
		select {
		case fact := <-facts:
			if fact.Type == loop.TurnFinished && fact.Scope.Task == goal.ID {
				oldSession = fact.Scope.Session
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Replace task leader"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-summaryStarted:
	case <-ctx.Done():
		t.Fatal("handover summary did not start")
	}
	close(holdOther)
	if _, err := e.SayGroup(ctx, g.ID, other.ID, "owner", group.Message{Text: "Urgent unrelated question", To: []event.ID{"a"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-otherAnswered:
	case <-ctx.Done():
		t.Fatal("a slow handover blocked another task's event delivery")
	}
	close(releaseSummary)
	var handover struct {
		Summary  string   `json:"summary"`
		Session  event.ID `json:"session"`
		Previous event.ID `json:"previous"`
	}
	for handover.Summary == "" {
		select {
		case fact := <-facts:
			if fact.Type == "thread.handed_over" {
				if err := json.Unmarshal(fact.Payload, &handover); err != nil {
					t.Fatal(err)
				}
			}
		case <-ctx.Done():
			t.Fatal("leader update did not hand over its thread")
		}
	}
	select {
	case <-inherited:
	case <-ctx.Done():
		t.Fatal("new leader did not receive the handover")
	}
	if handovers.Load() != 1 || handover.Previous != oldSession || handover.Session == "" || handover.Session == oldSession {
		t.Fatalf("handover=%+v calls=%d", handover, handovers.Load())
	}
}
