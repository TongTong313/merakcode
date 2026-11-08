package server_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestConfigRPCPersistsRelayAndUsesItForNewConversations(t *testing.T) {
	home := t.TempDir()
	called := make(chan string, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if r.Header.Get("Authorization") != "Bearer private-key" {
			t.Error("provider did not receive its configured key")
		}
		called <- body.Model
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Configured relay answered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for restart := range 2 {
		e, err := engine.New(engine.Deps{Workdir: home})
		if err != nil {
			t.Fatal(err)
		}
		instance, err := server.Start(e, home)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { instance.Close() })
		var level slog.LevelVar
		instance.SetLogLevel(&level)
		client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
		if err != nil {
			t.Fatal(err)
		}
		if restart == 0 {
			var result config.Value
			if err := client.Call(ctx, "config.set", map[string]any{"model": "relay/example-model", "providers": map[string]any{"relay": map[string]any{"protocol": "openai", "baseURL": provider.URL, "apiKey": "private-key", "models": map[string]any{"example-model": map[string]any{"window": 32000, "maxOutput": 2048}}}}}, &result); err != nil {
				t.Fatal(err)
			}
			if result.Providers["relay"].APIKey != "" || !result.Providers["relay"].HasKey {
				t.Fatal("configuration response exposed credentials or lost availability")
			}
			if err := client.Call(ctx, "config.set", map[string]any{"log": "debug"}, &result); err != nil {
				t.Fatal(err)
			}
		}
		if level.Level() != slog.LevelDebug {
			t.Fatal("runtime log level did not apply")
		}
		var models []catalog.Model
		if err := client.Call(ctx, "model.list", map[string]any{}, &models); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, model := range models {
			if model.Provider == "relay" && model.ID == "example-model" && model.Window == 32000 {
				found = true
			}
		}
		if !found {
			t.Fatal("configured model is absent from the catalog")
		}
		var created protocol.SessionCreateResult
		if err := client.Call(ctx, "session.create", map[string]any{}, &created); err != nil {
			t.Fatal(err)
		}
		if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, new(protocol.SubscribeResult)); err != nil {
			t.Fatal(err)
		}
		if err := client.Call(ctx, "session.send", map[string]any{"session": created.Session, "parts": []map[string]string{{"text": "Hello"}}}, new(struct{})); err != nil {
			t.Fatal(err)
		}
		select {
		case name := <-called:
			if name != "example-model" {
				t.Fatalf("model=%s", name)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		finished := false
		for !finished {
			select {
			case fact := <-client.Events:
				finished = fact.Type == "turn.finished"
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
		client.Close()
		instance.Close()
	}
}
