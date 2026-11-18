package sandbox_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAHandledPathRuleCreatesOneTaskWithoutWakingTheModel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	directory := t.TempDir()
	var calls atomic.Int32
	provider := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { calls.Add(1); return fake.Reply{Text: "Observed"} }}
	deps := enginetest.Deps(t)
	deps.Workdir = directory
	deps.Providers = map[string]model.Provider{"leader": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "profile", "leader"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Rules", Project: group.Project{Directory: directory}, Leader: "leader", Settings: group.Settings{Triggers: []group.Trigger{{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed"}}, Where: "docs/**/*.md", Cooldown: time.Minute, Then: group.Action{Kind: group.CreateTask, Template: "Sync English documentation"}}}}}, []group.Member{{ID: "owner", Kind: group.MemberHuman, Name: "Owner", Role: group.RoleOwner}, {ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader", Agent: lead.ID}}, []definition.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := e.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Actor: event.Actor{Kind: event.ActorExternal}, Type: "file.changed", Payload: json.RawMessage(`{"directory":"project","paths":["docs/guide.md"]}`)}); err != nil {
			t.Fatal(err)
		}
	}
	for {
		cards, err := e.GroupTasks(ctx, g.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(cards) == 1 {
			if cards[0].Title != "Sync English documentation" {
				t.Fatalf("task=%+v", cards[0])
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("rule did not create a task")
		case <-time.After(10 * time.Millisecond):
		}
	}
	select {
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	case <-time.After(3200 * time.Millisecond):
	}
	if cards, err := e.GroupTasks(ctx, g.ID); err != nil || len(cards) != 1 {
		t.Fatalf("cooldown tasks=%v, %v", cards, err)
	}
	if calls.Load() != 0 {
		t.Fatalf("handled event woke model %d times", calls.Load())
	}
}

func TestTriggerOutputsCannotRecursivelyTriggerMoreActions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	e, g := enginetest.TriggerGroup(t, group.Settings{Triggers: []group.Trigger{
		{ID: "ci", When: event.Filter{Types: []event.Type{"external.ci", "notice.sent"}}, Then: group.Action{Kind: group.NotifyHuman, Template: "CI notice"}},
	}}, map[string]model.Provider{"leader": fake.New(t)})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent}})
	defer stop()
	if _, err := e.EmitEvent(ctx, g.ID, "external.ci", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("missing notice")
	}
	select {
	case <-facts:
		t.Fatal("trigger output recursively produced another notice")
	case <-time.After(200 * time.Millisecond):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestTriggerAssignmentCannotRecursivelyCreateTasks(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e, g := enginetest.TriggerGroup(t, group.Settings{Triggers: []group.Trigger{{ID: "assign", When: event.Filter{Types: []event.Type{task.QueuedEvent}}, Then: group.Action{Kind: group.CreateTask, Template: "Follow assignment", Member: "worker"}}}}, map[string]model.Provider{"leader": enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Observed"} }}, "worker": fake.New(t, fake.Reply{Hold: make(chan struct{})})})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Created}})
	defer stop()
	seed, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Seed", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	created := false
	for !created {
		select {
		case fact := <-facts:
			created = fact.Scope.Task != seed.ID
		case <-ctx.Done():
			t.Fatal("missing triggered task")
		}
	}
	select {
	case <-facts:
		t.Fatal("assignment recursively created another task")
	case <-time.After(200 * time.Millisecond):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestDefaultRulesInformTheLeaderWhenAHumanCancelsOrBlocksATask(t *testing.T) {
	for _, phase := range []task.Phase{task.PhaseCancelled, task.PhaseStalled} {
		t.Run(string(phase), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			requests := make(chan model.Request, 4)
			provider := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply { requests <- request; return fake.Reply{Text: "Observed"} }}
			e, g := enginetest.TriggerGroup(t, group.Settings{}, map[string]model.Provider{"leader": provider})
			card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Tracked work", Workspace: "none", CreatedBy: event.Actor{Kind: "system", ID: "trigger:seed"}})
			if err != nil {
				t.Fatal(err)
			}
			if err := e.UpdateTask(ctx, card.ID, task.Update{Phase: phase}, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
				t.Fatal(err)
			}
			select {
			case request := <-requests:
				body, _ := json.Marshal(request.Messages)
				if !strings.Contains(string(body), string(phase)) || !strings.Contains(string(body), string(card.ID)) {
					t.Fatalf("missing task change: %s", body)
				}
			case <-ctx.Done():
				t.Fatal("default rule did not wake leader")
			}
		})
	}
}

func TestTriggerActionsNotifyWakeOrAssign(t *testing.T) {
	for _, test := range []struct {
		name   string
		action group.Action
	}{
		{"notify", group.Action{Kind: group.NotifyHuman, Template: "CI finished"}},
		{"wake", group.Action{Kind: group.WakeLeader, Priority: 3}},
		{"assign", group.Action{Kind: group.AssignMember, Member: "worker"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			requests := make(chan model.Request, 4)
			provider := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply { requests <- request; return fake.Reply{Text: "Observed"} }}
			e, g := enginetest.TriggerGroup(t, group.Settings{Triggers: []group.Trigger{{ID: "ci", When: event.Filter{Types: []event.Type{"external.ci.finished"}}, Then: test.action}}}, map[string]model.Provider{"leader": provider, "worker": fake.New(t, fake.Reply{Hold: make(chan struct{})})})
			facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
			defer stop()
			var id event.ID
			if test.action.Kind == group.AssignMember {
				card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Check CI", Workspace: "none", CreatedBy: event.Actor{Kind: "system", ID: "trigger:seed"}})
				if err != nil {
					t.Fatal(err)
				}
				id = card.ID
			}
			emitted, err := e.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID, Task: id}, Actor: event.Actor{Kind: event.ActorExternal}, Type: "external.ci.finished", Payload: json.RawMessage(`{"status":"success"}`)})
			if err != nil {
				t.Fatal(err)
			}
			for {
				select {
				case request := <-requests:
					if test.action.Kind != group.WakeLeader {
						t.Fatal("handled action woke leader")
					}
					if len(request.Messages) == 0 {
						t.Fatal("wake omitted the triggering event")
					}
					return
				case fact := <-facts:
					if test.action.Kind == group.NotifyHuman && fact.Type == group.NoticeSent {
						notice, err := event.Decode[group.Notice](fact)
						if err != nil || notice.Text != "CI finished" || len(notice.To) != 1 || notice.To[0] != "owner" || fact.Cause != emitted.ID {
							t.Fatalf("notice=%+v, %v", notice, err)
						}
						return
					}
					if test.action.Kind == group.AssignMember && fact.Type == task.QueuedEvent {
						card, err := event.Decode[task.Card](fact)
						if err != nil || len(card.Claims) != 1 || card.Claims[0].Member != "worker" {
							t.Fatalf("assignment=%+v, %v", card, err)
						}
						return
					}
				case <-ctx.Done():
					t.Fatal("trigger action did not finish")
				}
			}
		})
	}
}

func TestGroupInitiativeControlsEnvironmentalWakeups(t *testing.T) {
	for _, mode := range []string{"passive", "normal", "eager", ""} {
		t.Run("mode "+mode, func(t *testing.T) {
			requests := make(chan model.Request, 4)
			provider := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply { requests <- request; return fake.Reply{Text: "Observed"} }}
			settings := group.Settings{Initiative: group.Initiative(mode)}
			if mode == "passive" {
				settings.Triggers = []group.Trigger{{ID: "docs", When: event.Filter{Types: []event.Type{"file.changed"}}, Then: group.Action{Kind: group.CreateTask, Template: "Sync docs"}}}
			}
			e, g := enginetest.TriggerGroup(t, settings, map[string]model.Provider{"leader": provider})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			fact, err := e.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Type: "file.changed", Actor: event.Actor{Kind: event.ActorExternal}, Payload: json.RawMessage(`{"directory":"project","paths":["docs/guide.md"]}`)})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "passive" {
				select {
				case <-requests:
					t.Fatal("passive mode woke the model")
				case <-time.After(3200 * time.Millisecond):
				}
				if cards, err := e.GroupTasks(ctx, g.ID); err != nil || len(cards) != 0 {
					t.Fatalf("passive rule created tasks: %v %v", cards, err)
				}
				if saved, err := e.GetEvent(ctx, fact.ID); err != nil || saved.ID != fact.ID {
					t.Fatalf("passive event lost: %+v %v", saved, err)
				}
				return
			}
			if mode != "eager" {
				select {
				case <-requests:
					t.Fatal("normal mode did not batch the low-priority event")
				case <-time.After(100 * time.Millisecond):
				}
			}
			deadline := 4 * time.Second
			if mode == "eager" {
				deadline = time.Second
			}
			select {
			case <-requests:
			case <-time.After(deadline):
				t.Fatal("environment event did not wake leader")
			}
		})
	}
}

func TestExternalChangesInAnActiveScopeWakeTheGroupThreadWithAConflictNote(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	requests := make(chan model.Request, 4)
	provider := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply {
		requests <- request
		return fake.Reply{Text: "Checking the external change"}
	}}
	e, g := enginetest.TriggerGroup(t, group.Settings{}, map[string]model.Provider{"leader": provider, "worker": fake.New(t, fake.Reply{Hold: make(chan struct{})})})
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	_, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Update documentation", Areas: []string{"docs"}, Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type != task.Started {
				continue
			}
		case <-ctx.Done():
			t.Fatal("worker did not start")
		}
		break
	}
	if _, err := e.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Type: "file.changed", Actor: event.Actor{Kind: event.ActorExternal}, Payload: json.RawMessage(`{"directory":"project","paths":["docs/guide.md"]}`)}); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-requests:
		if !strings.Contains(fmt.Sprint(request.Messages), "Potential conflict") {
			t.Fatal("environment digest omitted the possible conflict")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("active task change was left in the low-priority batch")
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type != "turn.finished" || fact.Actor.ID != "leader" {
				continue
			}
			if fact.Scope.Group != g.ID || fact.Scope.Task != "" {
				t.Fatalf("leader scope=%+v", fact.Scope)
			}
			return
		case <-ctx.Done():
			t.Fatal("task leader did not start")
		}
	}
}
