package session_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestManagerRestoresSnapshotThenReplaysLaterEvents(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := session.NewManager(storage, bus)
	state, err := manager.Create(ctx, session.State{ID: "saved", System: "Frozen rules", Config: session.Config{Provider: "fake", Model: "fixture", Workdir: "workspace"}})
	if err != nil {
		t.Fatal(err)
	}
	emit := func(kind event.Type, payload string) {
		fact, err := bus.Publish(ctx, event.Event{Stream: "session:saved", Scope: event.Scope{Session: "saved"}, Type: kind, Actor: event.Actor{Kind: event.ActorHuman}, Payload: json.RawMessage(payload)})
		if err != nil {
			t.Fatal(err)
		}
		if err := session.Fold(state, fact); err != nil {
			t.Fatal(err)
		}
	}
	emit(session.MessageSent, `{"role":"user","parts":[{"text":"First"}]}`)
	if err := manager.Snapshot(ctx, state); err != nil {
		t.Fatal(err)
	}
	emit(session.MessageCompleted, `{"role":"assistant","parts":[{"text":"Reply"}],"usage":{"input":5,"output":2}}`)
	newBus := event.NewBus(storage, time.Now, event.NewID)
	restarted := session.NewManager(storage, newBus)
	loaded, err := restarted.Load(ctx, "saved")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.LastSeq != 3 || loaded.System != "Frozen rules" || loaded.Config.Provider != "fake" || len(loaded.Messages) != 2 || loaded.Messages[1].Parts[0].Text != "Reply" || loaded.Usage.Input != 5 {
		t.Fatalf("loaded = %+v", loaded)
	}
	if _, err := newBus.Publish(ctx, event.Event{Stream: "session:saved", Type: "message.sent", Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("resumed sequence: %v", err)
	}
	list, err := restarted.List(ctx)
	if err != nil || len(list) != 1 || list[0].ID != "saved" {
		t.Fatalf("list = %#v, %v", list, err)
	}
	if loaded.Messages[0].Role != model.User {
		t.Fatal("snapshot messages were lost")
	}
}
