package session_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestRecoveryDeliversAStoredChildReportMissingFromTheParent(t *testing.T) {
	ctx := context.Background()
	durable := storage.New()
	bus := event.NewBus(durable, time.Now, event.NewID)
	manager := session.NewManager(durable, bus)
	parent, err := manager.Create(ctx, session.State{ID: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.Create(ctx, session.State{ID: "child", Config: session.Config{Parent: parent.ID}})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		state *session.State
		kind  event.Type
		body  any
	}{
		{parent, session.ChildStarted, session.ChildResult{ID: child.ID}},
		{child, "turn.finished", struct {
			Stop  string       `json:"stop"`
			Final []model.Part `json:"final"`
		}{"answered", []model.Part{{Text: "Recovered research"}}}},
	} {
		body, _ := json.Marshal(item.body)
		fact, err := bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + item.state.ID), Scope: event.Scope{Session: item.state.ID}, Type: item.kind, Payload: body})
		if err != nil {
			t.Fatal(err)
		}
		if err := session.Fold(item.state, fact); err != nil {
			t.Fatal(err)
		}
	}
	restarted := session.NewManager(durable, event.NewBus(durable, time.Now, event.NewID))
	state, err := restarted.Load(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := restarted.Reconcile(ctx, state); err != nil {
			t.Fatal(err)
		}
	}
	if !state.Children[child.ID].Delivered || len(state.Messages) != 1 || state.Messages[0].Parts[1].Text != "Recovered research" {
		t.Fatalf("state=%+v", state)
	}
}
