package session_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestReconcilePairsEveryUnfinishedCallOnceAfterRestart(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := session.NewManager(storage, bus)
	state, err := manager.Create(ctx, session.State{ID: "crashed"})
	if err != nil {
		t.Fatal(err)
	}
	var cause event.ID
	for _, item := range []struct {
		kind event.Type
		body string
	}{
		{"turn.started", `{}`},
		{session.MessageCompleted, `{"role":"assistant","parts":[{"toolCall":{"id":"first","name":"read_file","input":{}}},{"toolCall":{"id":"second","name":"bash","input":{}}}]}`},
		{tool.Called, `{"id":"first","name":"read_file","input":{}}`},
	} {
		fact, err := bus.Publish(ctx, event.Event{Stream: "session:crashed", Scope: event.Scope{Session: "crashed"}, Type: item.kind, Payload: json.RawMessage(item.body)})
		if err != nil {
			t.Fatal(err)
		}
		if err := session.Fold(state, fact); err != nil {
			t.Fatal(err)
		}
		cause = fact.ID
	}
	if err := manager.Snapshot(ctx, state); err != nil {
		t.Fatal(err)
	}
	restarted := session.NewManager(storage, event.NewBus(storage, time.Now, event.NewID))
	loaded, err := restarted.Load(ctx, "crashed")
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Reconcile(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Reconcile(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	if len(loaded.Open) != 0 || loaded.Status != session.Idle || len(loaded.Messages) != 2 || len(loaded.Messages[1].Parts) != 2 {
		t.Fatalf("recovered state = %+v", loaded)
	}
	for i, id := range []string{"first", "second"} {
		result := loaded.Messages[1].Parts[i].ToolResult
		if result == nil || result.CallID != id || !result.IsError || result.Parts[0].Text != "Tool execution was interrupted." {
			t.Fatalf("result = %+v", result)
		}
	}
	facts, err := storage.Read(ctx, "session:crashed", 5, 20)
	if err != nil || len(facts) != 3 || facts[0].Cause != cause || facts[2].Type != "turn.finished" {
		t.Fatalf("recovery events = %+v, %v", facts, err)
	}
}
