package server_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/store/storetest"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestRemoteStorageContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		remote := server.NewRemoteStore()
		e, err := engine.New(engine.Deps{Store: remote})
		if err != nil {
			t.Fatal(err)
		}
		s := server.New(e, "storage-token")
		s.Storage = remote
		httpServer := httptest.NewServer(s)
		t.Cleanup(httpServer.Close)
		t.Cleanup(func() { s.Close() })
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		host, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "storage-token", protocol.HelloParams{Protocol: 1}, memory.New())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { host.Close() })
		if host.Hello.Store != "accepted" {
			t.Fatalf("store = %q", host.Hello.Store)
		}
		return remote
	})
}

func TestHistoryRequestsReadPersistedEventsAndSessions(t *testing.T) {
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	s := server.New(e, "token")
	defer s.Close()
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake"}, &created); err != nil {
		t.Fatal(err)
	}
	var list []session.Info
	if err := client.Call(ctx, "session.list", struct{}{}, &list); err != nil || len(list) != 1 || list[0].ID != created.Session {
		t.Fatalf("sessions = %#v, %v", list, err)
	}
	var facts []event.Event
	if err := client.Call(ctx, "events.read", protocol.EventsReadParams{Stream: event.Stream("session:" + created.Session), From: 1, Limit: 10}, &facts); err != nil || len(facts) != 1 {
		t.Fatalf("read = %#v, %v", facts, err)
	}
	var got event.Event
	if err := client.Call(ctx, "events.get", protocol.EventsGetParams{ID: facts[0].ID}, &got); err != nil || got.ID != facts[0].ID {
		t.Fatalf("get = %#v, %v", got, err)
	}
	if err := client.Call(ctx, "events.find", store.Query{Scope: event.Scope{Session: created.Session}, Types: []event.Type{session.Created}}, &facts); err != nil || len(facts) != 1 || facts[0].ID != got.ID {
		t.Fatalf("find = %#v, %v", facts, err)
	}
}

func TestOnlyOneStorageHostCanServeAtATime(t *testing.T) {
	remote := server.NewRemoteStore()
	e, err := engine.New(engine.Deps{Store: remote})
	if err != nil {
		t.Fatal(err)
	}
	s := server.New(e, "token")
	s.Storage = remote
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connect := func() *protocol.Client {
		host, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "token", protocol.HelloParams{Protocol: 1}, memory.New())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { host.Close() })
		return host
	}
	first := connect()
	second := connect()
	if first.Hello.Store != "accepted" || second.Hello.Store != "declined" {
		t.Fatalf("hosts = %q, %q", first.Hello.Store, second.Hello.Store)
	}
	if err := remote.Put(ctx, store.Doc{Kind: "state", Key: "saved", Body: []byte("one")}); err != nil {
		t.Fatal(err)
	}
	first.Close()
	for {
		_, err := remote.Fetch(ctx, "state", "saved")
		if errors.Is(err, store.ErrUnavailable) {
			break
		}
		if ctx.Err() != nil {
			t.Fatalf("disconnected host stayed available: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
	third := connect()
	if third.Hello.Store != "accepted" {
		t.Fatalf("replacement = %q", third.Hello.Store)
	}
}
