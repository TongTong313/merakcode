package engine_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestShutdownCancelsTheRunningTurnSavesTheSessionAndAnnouncesExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	disk := memory.New()
	entered := make(chan struct{})
	e, err := engine.New(engine.Deps{Store: disk, Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(entered); return nil }})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Run"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := e.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	facts, err := disk.Find(ctx, store.Query{Types: []event.Type{"turn.finished", "engine.shutdown"}})
	if err != nil || len(facts) != 2 {
		t.Fatalf("exit facts=%+v, %v", facts, err)
	}
	// Identifiers grow with time, which the coarse clock of some systems does not
	finished, shutdown := facts[0], facts[1]
	if finished.Type != "turn.finished" {
		finished, shutdown = shutdown, finished
	}
	if finished.Type != "turn.finished" || shutdown.Type != "engine.shutdown" || shutdown.ID < finished.ID {
		t.Fatalf("the shutdown must follow the cancelled turn: %+v", facts)
	}
	loaded, err := session.NewManager(disk, event.NewBus(disk, time.Now, event.NewID)).Load(ctx, id)
	if err != nil || loaded.Status != session.Idle {
		t.Fatalf("saved session=%+v, %v", loaded, err)
	}
	if _, err := disk.Fetch(ctx, "snapshot", string(id)); err != nil {
		t.Fatal(err)
	}
}
