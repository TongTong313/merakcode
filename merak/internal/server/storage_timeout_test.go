package server_test

import (
	"context"
	"encoding/json"
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

func TestUnresponsiveStorageHandsPendingEventsToBufferAfterThirtySeconds(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 34*time.Second)
	defer cancel()
	remote := server.NewRemoteStore()
	buffer := store.NewBuffered(remote, 20)
	e, err := engine.New(engine.Deps{Store: buffer})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.StorageChanged, engine.SentinelFlagged}})
	defer stop()
	s := server.New(e, "token")
	s.Storage = remote
	host := httptest.NewServer(s)
	defer host.Close()
	defer func() {
		finish, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = e.ReconnectStorage(finish, memory.New())
		_ = s.Close()
	}()
	conn, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"capabilities":{"store":true}}}`)); err != nil {
		t.Fatal(err)
	}
	for {
		body, err := conn.Read()
		if err != nil {
			t.Fatal(err)
		}
		var request protocol.Message
		_ = json.Unmarshal(body, &request)
		if request.Method == "store.find" {
			break
		}
	}
	completed := make(chan error, 1)
	go func() {
		_, err := e.Bus.Publish(ctx, event.Event{Stream: "session:waiting", Type: "message.sent", Payload: json.RawMessage(`{}`)})
		completed <- err
	}()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("storage did not hand publication to buffer after 30 seconds")
	}
	disconnected, flagged := false, false
	for !disconnected || !flagged {
		select {
		case fact := <-facts:
			if fact.Type == engine.StorageChanged {
				state, _ := event.Decode[store.BufferState](fact)
				disconnected = !state.Connected
			}
			flagged = flagged || fact.Type == engine.SentinelFlagged
		case <-ctx.Done():
			t.Fatalf("storage=%v sentinel=%v", disconnected, flagged)
		}
	}
	if buffer.State().Connected || buffer.State().Pending < 1 {
		t.Fatalf("buffer=%+v", buffer.State())
	}
}
