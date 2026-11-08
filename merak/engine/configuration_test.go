package engine_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

func TestQueuedModelChangeKeepsTheRunningTurnAndSurvivesReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started, release := make(chan struct{}), make(chan struct{})
	first := fake.New(t, fake.Reply{Text: "First", Hold: release, Expect: func(req model.Request) error {
		close(started)
		if req.Model != "first" {
			return fmt.Errorf("wrong first model: %s", req.Model)
		}
		return nil
	}})
	second := fake.New(t, fake.Reply{Text: "Second", Expect: func(req model.Request) error {
		if req.Model != "second" || req.Thinking != model.ThinkingHigh || len(req.Messages) != 3 {
			return fmt.Errorf("selection or history lost: %+v", req)
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"one": first, "two": second}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "one", Model: "first"})
	if err != nil {
		t.Fatal(err)
	}
	facts, unsubscribe := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.finished"}})
	defer unsubscribe()
	if err := e.Send(ctx, id, []model.Part{{Text: "Begin"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Continue"}}, session.Selection{Provider: "two", Model: "second", Thinking: model.ThinkingHigh}); err != nil {
		t.Fatal(err)
	}
	close(release)
	for range 2 {
		select {
		case fact := <-facts:
			outcome, err := event.Decode[loop.Outcome](fact)
			if err != nil || outcome.Stop != loop.Answered {
				t.Fatalf("turn failed: %+v %v", outcome, err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	stored, err := e.ReadEvents(ctx, event.Stream("session:"+id), 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	var state session.State
	for _, fact := range stored {
		if err := session.Fold(&state, fact); err != nil {
			t.Fatal(err)
		}
	}
	if state.Config.Provider != "two" || state.Config.Model != "second" || state.Config.Thinking != model.ThinkingHigh || len(state.Messages) != 4 {
		t.Fatalf("replay lost selection: %+v", state)
	}
}

func TestSnapshotAndFollowingEventsRestoreAConversation(t *testing.T) {
	ctx := context.Background()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Done"})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Model: "model"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := e.SessionSnapshot(ctx, id)
	if err != nil || snapshot.ID != id || snapshot.LastSeq != 1 {
		t.Fatalf("initial snapshot: %+v %v", snapshot, err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.finished"}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Begin"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-time.After(5 * time.Second):
		t.Fatal("turn did not finish")
	}
	if len(snapshot.Messages) != 0 {
		t.Fatal("published snapshot was mutated")
	}
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	incremental, err := e.ReadEvents(ctx, event.Stream("session:"+id), snapshot.LastSeq+1, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range incremental {
		if err := session.Fold(&snapshot, fact); err != nil {
			t.Fatal(err)
		}
	}
	saved, err := e.SessionSnapshot(ctx, id)
	if err != nil || saved.LastSeq != snapshot.LastSeq || len(saved.Messages) != 2 || saved.Messages[1].Parts[0].Text != "Done" {
		t.Fatalf("saved snapshot: %+v %v", saved, err)
	}
}

func TestRemovedProviderDoesNotSendQueuedInputToPreviousProvider(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started, release := make(chan struct{}), make(chan struct{})
	first := fake.New(t, fake.Reply{Text: "First", Hold: release, Expect: func(model.Request) error { close(started); return nil }})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"one": first, "two": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "one", Model: "first"})
	if err != nil {
		t.Fatal(err)
	}
	facts, unsubscribe := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.finished"}})
	defer unsubscribe()
	if err := e.Send(ctx, id, []model.Part{{Text: "Begin"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Private input"}}, session.Selection{Provider: "two", Model: "second"}); err != nil {
		t.Fatal(err)
	}
	e.SetProvider("two", nil)
	close(release)
	for index := range 2 {
		select {
		case fact := <-facts:
			outcome, err := event.Decode[loop.Outcome](fact)
			if err != nil {
				t.Fatal(err)
			}
			if index == 1 && outcome.Code != "MRK-2001" {
				t.Fatalf("removed provider outcome: %+v", outcome)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
