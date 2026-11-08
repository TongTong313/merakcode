package engine_test

import (
	"context"
	"errors"
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

func TestShutdownWaitsForHostThenSavesCancelledSessionAndAnnouncesExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	disk := memory.New()
	buffer := store.NewBuffered(disk, 4096)
	entered := make(chan struct{})
	e, err := engine.New(engine.Deps{Store: buffer, Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(entered); return nil }})}})
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
	buffer.Disconnect()
	stopped := make(chan error, 1)
	go func() { stopped <- e.Shutdown(ctx) }()
	select {
	case err := <-stopped:
		t.Fatalf("shutdown did not wait for host: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	if err := e.ReconnectStorage(ctx, disk); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	facts, err := disk.Find(ctx, store.Query{Types: []event.Type{"turn.finished", "engine.shutdown"}})
	if err != nil || len(facts) != 2 || facts[0].Type != "turn.finished" || facts[1].Type != "engine.shutdown" {
		t.Fatalf("exit facts=%+v, %v", facts, err)
	}
	loaded, err := session.NewManager(disk, event.NewBus(disk, time.Now, event.NewID)).Load(ctx, id)
	if err != nil || loaded.Status != session.Idle {
		t.Fatalf("saved session=%+v, %v", loaded, err)
	}
	if _, err := disk.Fetch(ctx, "snapshot", string(id)); err != nil {
		t.Fatal(err)
	}
}

func TestShutdownHonorsDeadlineWhenHostStaysOffline(t *testing.T) {
	buffer := store.NewBuffered(nil, 4096)
	e, err := engine.New(engine.Deps{Store: buffer})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := e.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown=%v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("shutdown ignored its deadline")
	}
}

func TestRepeatedCloseDoesNotRestartTheShutdownDeadline(t *testing.T) {
	disk := memory.New()
	buffer := store.NewBuffered(disk, 1)
	entered := make(chan struct{})
	e, err := engine.New(engine.Deps{Store: buffer, Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(entered); return nil }})}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
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
	buffer.Disconnect()
	defer buffer.Reconnect(context.Background(), disk)
	for !buffer.Full() {
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		time.Sleep(time.Millisecond)
	}
	short, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	if err := e.Shutdown(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first shutdown=%v", err)
	}
	done := make(chan error, 1)
	go func() { done <- e.Close() }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("repeated shutdown=%v", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("repeated close restarted the timeout")
	}
}
