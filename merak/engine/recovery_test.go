package engine_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestEngineRecoversAnInterruptedSessionBeforeItIsOpened(t *testing.T) {
	ctx := context.Background()
	disk := memory.New()
	bus := event.NewBus(disk, time.Now, event.NewID)
	manager := session.NewManager(disk, bus)
	if _, err := manager.Create(ctx, session.State{ID: "abandoned"}); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		kind event.Type
		body string
	}{
		{"turn.started", `{}`},
		{"message.completed", `{"role":"assistant","parts":[{"toolCall":{"id":"unfinished","name":"bash","input":{}}}]}`},
		{"tool.called", `{"id":"unfinished","name":"bash","input":{}}`},
	} {
		if _, err := bus.Publish(ctx, event.Event{Stream: "session:abandoned", Scope: event.Scope{Session: "abandoned"}, Type: item.kind, Payload: json.RawMessage(item.body)}); err != nil {
			t.Fatal(err)
		}
	}
	e, err := engine.New(engine.Deps{Store: disk})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	facts, err := disk.Read(ctx, "session:abandoned", 5, 10)
	if err != nil || len(facts) != 2 || facts[0].Type != "tool.completed" || facts[1].Type != "turn.finished" {
		t.Fatalf("recovery=%+v, %v", facts, err)
	}
	loaded, err := session.NewManager(disk, event.NewBus(disk, time.Now, event.NewID)).Load(ctx, "abandoned")
	if err != nil || loaded.Status != session.Idle || len(loaded.Open) != 0 {
		t.Fatalf("restored=%+v, %v", loaded, err)
	}
}
