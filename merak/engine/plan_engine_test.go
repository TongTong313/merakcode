package engine_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/plan"
)

func TestAnyModeCanWriteAPlanAndTheTurnEndsWithThePlanUnderReview(t *testing.T) {
	for _, mode := range []permission.Mode{permission.ModeAsk, permission.ModeAuto, permission.ModeTakeover} {
		t.Run(string(mode), func(t *testing.T) {
			provider := fake.New(t,
				integrationCall("write_plan", map[string]any{"content": "# Plan\n1. Read the code\n2. Change it"}),
				fake.Reply{Text: "This reply must never be asked for.", Expect: func(model.Request) error {
					return fmt.Errorf("the turn did not end after write_plan")
				}},
			)
			project := t.TempDir()
			e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: mode})
			if err != nil {
				t.Fatal(err)
			}
			updated, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{plan.Updated}})
			defer stop()
			r := &chatRig{t: t, e: e, ctx: t.Context(), dir: project, id: id}
			r.say("Plan the change")
			got, err := e.GetPlan(t.Context(), id)
			if err != nil || got.Status != plan.Review || got.Revision != 1 || !strings.Contains(got.Content, "Read the code") {
				t.Fatalf("plan=%+v err=%v", got, err)
			}
			select {
			case <-updated:
			default:
				t.Fatal("no plan.updated event")
			}
		})
	}
}

func TestAMessageSentWithPlanTrueAsksForAPlanFirstAndExecutionRunsTheSnapshot(t *testing.T) {
	var inputs []string
	capture := func(req model.Request) error {
		var text strings.Builder
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			text.WriteString(part.Text + "\n")
		}
		inputs = append(inputs, text.String())
		return nil
	}
	provider := fake.New(t,
		fake.Reply{Calls: integrationCall("write_plan", map[string]any{"content": "# Plan\n1. Step one\n2. Step two"}).Calls, Expect: capture},
		fake.Reply{Calls: integrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Step one", "status": "in_progress"}, {"content": "Step two", "status": "pending"}}}).Calls, Expect: capture},
		fake.Reply{Calls: integrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Step one", "status": "done"}, {"content": "Step two", "status": "in_progress"}}}).Calls},
		fake.Reply{Calls: integrationCall("todo_write", map[string]any{"items": []map[string]string{{"content": "Step one", "status": "done"}, {"content": "Step two", "status": "done"}}}).Calls},
		fake.Reply{Text: "All steps are done."},
	)
	project := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Bus.Subscribe(turnFilter(id))
	defer stop()
	if err := e.SendPlanned(t.Context(), id, []model.Part{{Text: "Refactor the parser"}}); err != nil {
		t.Fatal(err)
	}
	<-turns
	if !strings.Contains(inputs[0], "Refactor the parser") || !strings.Contains(inputs[0], "write_plan") || !strings.Contains(inputs[0], "do not change any file") {
		t.Fatalf("the first message does not ask for a plan:\n%s", inputs[0])
	}
	if _, err := e.ExecutePlan(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	got, err := e.GetPlan(t.Context(), id)
	if err != nil || got.Status != plan.Executing {
		t.Fatalf("after execute: %+v err=%v", got, err)
	}
	if _, err := e.SavePlan(t.Context(), id, "# Plan\n1. A different plan", got.Revision); err != nil {
		t.Fatal(err)
	}
	<-turns
	if !strings.Contains(inputs[1], "Step one") || !strings.Contains(inputs[1], "Step two") || strings.Contains(inputs[1], "A different plan") {
		t.Fatalf("the execution message is not the snapshot:\n%s", inputs[1])
	}
	waitFor(t, t.Context(), "the plan to finish", func() bool {
		current, err := e.GetPlan(t.Context(), id)
		return err == nil && current.Status == plan.Done
	})
}

func TestAChildReadsThePlanOfItsParentAndPlanSavesWithAStaleRevisionAreRefused(t *testing.T) {
	provider := fake.New(t,
		integrationCall("write_plan", map[string]any{"content": "Parent plan"}),
	)
	project := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeAsk})
	if err != nil {
		t.Fatal(err)
	}
	r := &chatRig{t: t, e: e, ctx: t.Context(), dir: project, id: id}
	r.say("Plan it")
	child, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Parent: id})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := e.GetPlan(t.Context(), child); err != nil || got.Content != "Parent plan" || got.Session != id {
		t.Fatalf("the child reads %+v err=%v", got, err)
	}
	var coded *engine.Error
	if _, err := e.SavePlan(t.Context(), id, "Edited", 0); !errors.As(err, &coded) || coded.Code != "MRK-4011" || !errors.Is(err, plan.ErrStale) {
		t.Fatalf("a stale save must carry its own code, got %v", err)
	}
	if _, err := e.StopPlan(t.Context(), id); !errors.As(err, &coded) || coded.Code != "MRK-4012" {
		t.Fatalf("stopping a plan that does not run: %v", err)
	}
	if _, err := e.GetPlan(t.Context(), "no-such-session"); err == nil {
		t.Fatal("the plan of a missing session was returned")
	}
}

// Cancelling the turn that runs a plan stops the plan, so it can be started again; before, the plan stayed
// "executing" for ever and nothing could start it.
func TestCancellingTheTurnThatRunsAPlanStopsThePlanAndItCanBeRunAgain(t *testing.T) {
	hold := make(chan struct{})
	provider := fake.New(t,
		fake.Reply{Calls: integrationCall("write_plan", map[string]any{"content": "# Plan\n1. Step one"}).Calls},
		fake.Reply{Text: "Working.", Hold: hold},
		fake.Reply{Text: "Working again."},
	)
	project := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Bus.Subscribe(turnFilter(id))
	defer stop()
	if err := e.SendPlanned(t.Context(), id, []model.Part{{Text: "Do it"}}); err != nil {
		t.Fatal(err)
	}
	<-turns
	started, stopStarted := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.started"}})
	defer stopStarted()
	if _, err := e.ExecutePlan(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := e.Cancel(id); err != nil {
		t.Fatal(err)
	}
	close(hold)
	<-turns
	waitFor(t, t.Context(), "the cancelled plan to read as stopped", func() bool {
		current, err := e.GetPlan(t.Context(), id)
		return err == nil && current.Status == plan.Stopped
	})
	if _, err := e.ExecutePlan(t.Context(), id); err != nil {
		t.Fatalf("a stopped plan must be able to run again: %v", err)
	}
}

// A turn that is cancelled while it is not running a plan leaves the plan alone.
func TestCancellingAnOrdinaryTurnLeavesAPlanUnderReviewAsItIs(t *testing.T) {
	hold := make(chan struct{})
	provider := fake.New(t,
		fake.Reply{Calls: integrationCall("write_plan", map[string]any{"content": "# Plan\n1. Step one"}).Calls},
		fake.Reply{Text: "A question's answer.", Hold: hold},
	)
	project := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Bus.Subscribe(turnFilter(id))
	defer stop()
	if err := e.SendPlanned(t.Context(), id, []model.Part{{Text: "Plan it"}}); err != nil {
		t.Fatal(err)
	}
	<-turns
	started, stopStarted := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.started"}})
	defer stopStarted()
	if err := e.Send(t.Context(), id, []model.Part{{Text: "Another question"}}); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := e.Cancel(id); err != nil {
		t.Fatal(err)
	}
	close(hold)
	<-turns
	got, err := e.GetPlan(t.Context(), id)
	if err != nil || got.Status != plan.Review {
		t.Fatalf("the plan under review changed: %+v err=%v", got, err)
	}
}
