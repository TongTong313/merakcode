package server_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestStopDeliversTheCancelledTurnAndShutdownAndStoresThem(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	disk := memory.New()
	entered := make(chan struct{})
	deps := enginetest.Deps(t)
	deps.Store = disk
	deps.Workdir = t.TempDir()
	deps.Providers = map[string]model.Provider{"fake": fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(entered); return nil }})}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Call(ctx, "events.subscribe", event.Filter{}, nil); err != nil {
		t.Fatal(err)
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: t.TempDir(), Provider: "fake"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Run"}}}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := client.Call(ctx, "engine.stop", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	cancelled := false
	for {
		select {
		case fact, ok := <-client.Events:
			if !ok {
				t.Fatal("connection closed before shutdown event")
			}
			if fact.Type == "turn.finished" {
				cancelled = true
			}
			if fact.Type == "engine.shutdown" {
				if !cancelled {
					t.Fatal("shutdown preceded cancellation")
				}
				if _, err := disk.Get(ctx, fact.ID); err != nil {
					t.Fatal("the shutdown event was not stored")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
