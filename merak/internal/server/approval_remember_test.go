package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestProtocolRetainsApprovalRememberScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var handler *server.Server
	replies := make(chan permission.Reply, 1)
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: []byte(`{"path":"approved.txt","content":"approved"}`)}}}, fake.Reply{Text: "Finished"})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fixture": provider}, Ask: func(ctx context.Context, request permission.Request) (permission.Reply, error) {
		reply, err := handler.Ask(ctx, request)
		replies <- reply
		return reply, err
	}})
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "fixture-token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "fixture-token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fixture"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Write"}}}, nil); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-client.Events:
			if fact.Type != permission.Requested {
				continue
			}
			params := map[string]any{"request": fact.ID, "decision": "allow", "remember": "unknown"}
			if err := client.Call(ctx, "permission.reply", params, nil); err == nil {
				t.Fatal("invalid remember scope was accepted")
			}
			params["remember"] = "always"
			if err := client.Call(ctx, "permission.reply", params, nil); err != nil {
				t.Fatal(err)
			}
			select {
			case reply := <-replies:
				if reply.Remember != "always" || reply.Decision != permission.Allow {
					t.Fatalf("approval = %+v", reply)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
