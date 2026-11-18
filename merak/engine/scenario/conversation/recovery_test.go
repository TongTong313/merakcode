package conversation_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
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
	deps := enginetest.Deps(t)
	deps.Store = disk
	e, err := engine.New(deps)
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
