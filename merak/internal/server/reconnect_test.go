package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestDisconnectDuringRecoveryReleasesPendingPublication(t *testing.T) {
	remote := server.NewRemoteStore()
	buffer := store.NewBuffered(remote, 20)
	e, err := engine.New(engine.Deps{Store: buffer, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	s := server.New(e, "token")
	s.Storage = remote
	host := httptest.NewServer(s)
	defer host.Close()
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"capabilities":{"store":true}}}`)); err != nil {
		t.Fatal(err)
	}
	// Hold the recovery query without replying, as a disconnected storage host would.
	for {
		body, err := conn.Read()
		if err != nil {
			t.Fatal(err)
		}
		var request protocol.Message
		if err := json.Unmarshal(body, &request); err != nil {
			t.Fatal(err)
		}
		if request.Method == "store.find" {
			break
		}
	}
	published := make(chan error, 1)
	go func() {
		_, err := e.Bus.Publish(ctx, event.Event{Stream: "session:pending", Type: "message.sent", Payload: json.RawMessage(`{}`)})
		published <- err
	}()
	select {
	case err := <-published:
		t.Fatalf("publication did not wait for storage: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	conn.Close()
	select {
	case err := <-published:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("disconnect did not release the pending publication")
	}
	if buffer.State().Connected {
		t.Fatal("storage remained online")
	}
	replacement, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1}, memory.New())
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	if err := replacement.Call(ctx, "session.list", struct{}{}, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStorageHostReconnectFlushesBufferedEvents(t *testing.T) {
	remote := server.NewRemoteStore()
	buffer := store.NewBuffered(remote, 20)
	e, err := engine.New(engine.Deps{Store: buffer})
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
	disk := memory.New()
	connect := func() *protocol.Client {
		client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "token", protocol.HelloParams{Protocol: 1}, disk)
		if err != nil {
			t.Fatal(err)
		}
		if client.Hello.Store != "accepted" {
			t.Fatal("replacement host was declined")
		}
		return client
	}
	first := connect()
	first.Close()
	for {
		_, err := remote.Get(ctx, "absent")
		if errors.Is(err, store.ErrUnavailable) {
			break
		}
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		time.Sleep(time.Millisecond)
	}
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: "session:buffered", Type: "message.sent", Payload: json.RawMessage(`{"role":"user","parts":[{"text":"saved offline"}]}`)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buffer.Get(ctx, fact.ID); !errors.Is(err, store.ErrUnavailable) {
		t.Fatalf("offline read=%v", err)
	}
	second := connect()
	defer second.Close()
	for {
		got, err := disk.Get(ctx, fact.ID)
		if err == nil && got.Seq == 1 {
			break
		}
		if ctx.Err() != nil {
			t.Fatalf("queued event was not flushed: %v", err)
		}
		time.Sleep(time.Millisecond)
	}
}
