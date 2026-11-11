package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestConfiguredPermissionModeAppliesOnlyToNewSessions(t *testing.T) {
	ctx := t.Context()
	home := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fixture": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := protocol.Connect(ctx, s.Info.Endpoint, s.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var first event.ID
	for _, mode := range []string{"ask", "auto", "takeover"} {
		var settings map[string]any
		if err := c.Call(ctx, "config.set", map[string]string{"permissionMode": mode}, &settings); err != nil {
			t.Fatal(err)
		}
		if settings["permissionMode"] != mode {
			t.Fatalf("settings=%v", settings)
		}
		var created protocol.SessionCreateResult
		if err := c.Call(ctx, "session.create", map[string]any{"workdir": t.TempDir(), "provider": "fixture"}, &created); err != nil {
			t.Fatal(err)
		}
		var saved session.State
		if err := c.Call(ctx, "session.snapshot", map[string]any{"session": created.Session}, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.Config.Mode != permission.Mode(mode) {
			t.Fatalf("mode=%s", saved.Config.Mode)
		}
		if first == "" {
			first = created.Session
		}
	}
	var original session.State
	if err := c.Call(ctx, "session.snapshot", map[string]any{"session": first}, &original); err != nil {
		t.Fatal(err)
	}
	if original.Config.Mode != permission.ModeAsk {
		t.Fatalf("existing mode=%s", original.Config.Mode)
	}
	if err := c.Call(ctx, "config.set", map[string]string{"permissionMode": "invalid"}, new(config.Value)); err == nil {
		t.Fatal("accepted invalid mode")
	}
}

func TestConfigRPCPersistsRelayAndUsesItForNewConversations(t *testing.T) {
	home := t.TempDir()
	// The answer and the title of the conversation each make one request.
	called := make(chan string, 16)
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
	vault := credential.NewFile(t.TempDir())
	for restart := range 2 {
		e, err := engine.New(engine.Deps{Workdir: home, Vault: vault, Providers: map[string]model.Provider{"fixture": fake.New(t)}})
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
		if err := client.Call(ctx, "session.create", map[string]any{"workdir": home}, &created); err != nil {
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

func TestConfiguredDefaultModelRunsMembersWithoutAModel(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	home := t.TempDir()
	provider := fake.New(t, fake.Reply{Text: "Planning", Expect: func(req model.Request) error {
		if req.Model != "default-model" || req.Thinking != "high" {
			return fmt.Errorf("model=%q thinking=%q", req.Model, req.Thinking)
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fixture": provider}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := protocol.Connect(ctx, s.Info.Endpoint, s.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Call(ctx, "config.set", map[string]string{"model": "fixture/default-model", "thinking": "high"}, new(map[string]any)); err != nil {
		t.Fatal(err)
	}
	var g group.Group
	if err := c.Call(ctx, "group.create", map[string]any{"name": "Defaults", "kind": "local", "project": group.Project{Directory: home}, "leader": "leader", "members": []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"},
		{ID: "local-human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}}, &g); err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := c.Call(ctx, "group.say", map[string]any{"group": g.ID, "text": "Plan the work", "to": []string{"leader"}}, new(event.ID)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("the Leader did not answer with the configured default model")
	}
}

func TestSettingAKeyDoesNotCopyAnEnvironmentAddressIntoTheFile(t *testing.T) {
	ctx := t.Context()
	home := t.TempDir()
	t.Setenv("OPENAI_BASE_URL", "http://env.example")
	original := `{
  // keep this comment
  "provider": { "openai": { "models": { "gpt-4.1": { "limit": { "context": 64000 } } } } }
}
`
	file := filepath.Join(home, "merakcode.jsonc")
	if err := os.WriteFile(file, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	s, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := protocol.Connect(ctx, s.Info.Endpoint, s.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var visible config.Value
	if err := c.Call(ctx, "config.get", struct{}{}, &visible); err != nil {
		t.Fatal(err)
	}
	if visible.Providers["openai"].BaseURL != "" {
		t.Fatalf("the public configuration shows the address of the environment as a setting: %q", visible.Providers["openai"].BaseURL)
	}
	if err := c.Call(ctx, "config.set", map[string]any{"providers": map[string]any{"openai": map[string]any{"apiKey": "sk-new"}}}, &visible); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(saved), "baseURL") || strings.Contains(string(saved), "env.example") {
		t.Fatalf("the address of the environment was written to the file:\n%s", saved)
	}
	if !strings.Contains(string(saved), "keep this comment") || !strings.Contains(string(saved), `"context": 64000`) || strings.Contains(string(saved), "sk-new") {
		t.Fatalf("the file lost content or kept the key:\n%s", saved)
	}
}

func TestTheBoardArchivesAfterTheDaysConfigured(t *testing.T) {
	ctx := t.Context()
	home := t.TempDir()
	var skew atomic.Int64
	e, err := engine.New(engine.Deps{Workdir: home, Now: func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }})
	if err != nil {
		t.Fatal(err)
	}
	s, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := connectAs(t, s, protocol.LocalHuman, protocol.Capabilities{})
	var card task.Card
	if err := c.Call(ctx, "task.create", map[string]any{"title": "Old news", "project": home}, &card); err != nil {
		t.Fatal(err)
	}
	if err := c.Call(ctx, "task.cancel", map[string]any{"task": card.ID}, new(task.Card)); err != nil {
		t.Fatal(err)
	}
	var listed []task.Card
	archived := func() int {
		if err := e.Board.ArchiveStale(ctx); err != nil {
			t.Fatal(err)
		}
		if err := c.Call(ctx, "task.list", map[string]any{"archived": true}, &listed); err != nil {
			t.Fatal(err)
		}
		return len(listed)
	}
	if err := c.Call(ctx, "config.set", map[string]any{"board": map[string]any{"autoArchiveDays": 7}}, new(config.Value)); err != nil {
		t.Fatal(err)
	}
	skew.Store(int64(4 * 24 * time.Hour))
	if archived() != 0 {
		t.Fatal("archived after 4 days although 7 are configured")
	}
	skew.Store(int64(8 * 24 * time.Hour))
	if archived() != 1 {
		t.Fatal("not archived after 8 days with 7 configured")
	}
}
