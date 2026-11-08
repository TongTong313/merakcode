package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestHelloRequiresTokenAndMatchingProtocol(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	for _, test := range []struct {
		name, token string
		version     int
		accepted    bool
	}{
		{"accepts compatible client", "fixture-token", 1, true},
		{"rejects wrong token", "wrong-token", 1, false},
		{"rejects wrong protocol", "fixture-token", 99, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), test.token, protocol.HelloParams{Protocol: test.version, Client: protocol.ClientInfo{Name: "test", Version: "1.0.0"}})
			if err == nil {
				defer client.Close()
			}
			if (err == nil) != test.accepted {
				t.Fatalf("accepted=%v err=%v", test.accepted, err)
			}
			if test.accepted && client.Hello.Protocol != 1 {
				t.Fatalf("hello=%+v", client.Hello)
			}
		})
	}
}

func TestSessionRequestsDeliverOrderedNotificationsAndRetainHistory(t *testing.T) {
	p := fake.New(t, fake.Reply{Text: "First reply"}, fake.Reply{Text: "Second reply", Expect: func(req model.Request) error {
		if len(req.Messages) != 3 || req.Messages[1].Parts[0].Text != "First reply" {
			return fmt.Errorf("history=%+v", req.Messages)
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": p}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "fixture-token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1.0.0"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake"}, &created); err != nil {
		t.Fatal(err)
	}
	if created.Session == "" {
		t.Fatal("missing session id")
	}
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, nil); err != nil {
		t.Fatal(err)
	}
	var seq uint64
	for _, text := range []string{"First", "Second"} {
		if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: text}}}, nil); err != nil {
			t.Fatal(err)
		}
		completed := false
	turn:
		for {
			select {
			case notification := <-client.Events:
				if notification.Scope.Session != created.Session {
					t.Fatalf("wrong session: %+v", notification)
				}
				if notification.Seq != 0 {
					if seq != 0 && notification.Seq != seq+1 {
						t.Fatalf("seq=%d previous=%d", notification.Seq, seq)
					}
					seq = notification.Seq
				}
				if notification.Type == session.MessageCompleted {
					completed = true
				}
				if notification.Type == "turn.finished" {
					if !completed {
						t.Fatal("turn finished before its message")
					}
					break turn
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
}

func TestHandshakeRejectsUntrustedOrigins(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	for _, origin := range []string{"https://example.com", "null", "http://127.0.0.1:1"} {
		req, err := http.NewRequest(http.MethodGet, httpServer.URL, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer fixture-token")
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		req.Header.Set("Sec-WebSocket-Version", "13")
		req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
		req.Header.Set("Origin", origin)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("origin=%s status=%d", origin, response.StatusCode)
		}
	}
}

func TestCancelStopsTheActiveModelAndAllowsAnotherTurn(t *testing.T) {
	started := make(chan struct{})
	p := fake.New(t, fake.Reply{Text: "Must not finish", Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }}, fake.Reply{Text: "Continued"})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": p}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "fixture-token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1.0.0"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Wait"}}}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := client.Call(ctx, "session.cancel", protocol.SessionCancelParams{Session: created.Session}, nil); err != nil {
		t.Fatal(err)
	}
	for _, want := range []loop.StopReason{loop.Cancelled, loop.Answered} {
		if want == loop.Answered {
			if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Continue"}}}, nil); err != nil {
				t.Fatal(err)
			}
		}
	turn:
		for {
			select {
			case fact := <-client.Events:
				if fact.Type == loop.TurnFinished {
					outcome, err := event.Decode[loop.Outcome](fact)
					if err != nil || outcome.Stop != want {
						t.Fatalf("outcome=%+v err=%v", outcome, err)
					}
					break turn
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
}

func TestProtocolRejectsUnknownInputFieldsAndUnsolicitedApprovals(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "fixture-token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, test := range []struct {
		method string
		params any
		code   string
	}{
		{"session.create", map[string]any{"provider": "fake", "unexpected": true}, "MRK-4001"},
		{"events.subscribe", map[string]any{"unexpected": true}, "MRK-4001"},
		{"permission.reply", map[string]any{"request": "unknown", "decision": "allow"}, "MRK-5002"},
	} {
		var failure *protocol.Error
		if err := client.Call(ctx, test.method, test.params, nil); !errors.As(err, &failure) || failure.Data.Code != test.code {
			t.Errorf("method=%s err=%v", test.method, err)
		}
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake"}, &created); err != nil || created.Session == "" {
		t.Fatalf("connection did not recover after rejection: %v", err)
	}
}

func TestMalformedRPCRequestsGetErrorsWithoutClosingTheConnection(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), "fixture-token")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := conn.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"client":{"name":"test","version":"1"}}}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Read(); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		body string
		code int
	}{
		{`{`, -32700},
		{`{"jsonrpc":"1.0","id":2,"method":"events.subscribe","params":{}}`, -32600},
		{`{"jsonrpc":"2.0","id":true,"method":"events.subscribe","params":{}}`, -32600},
	} {
		if err := conn.Write([]byte(test.body)); err != nil {
			t.Fatal(err)
		}
		body, err := conn.Read()
		if err != nil {
			t.Fatal(err)
		}
		var reply protocol.Message
		if err := json.Unmarshal(body, &reply); err != nil || reply.Error == nil || reply.Error.Code != test.code {
			t.Fatalf("reply=%s err=%v", body, err)
		}
	}
}
