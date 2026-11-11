package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestPausedGroupRetainsMessagesUntilAnAdminResumesIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	provider := fake.New(t, fake.Reply{Text: "Resumed", Expect: func(req model.Request) error {
		body, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(body), "Keep this message") {
			return fmt.Errorf("paused message was lost")
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	as := func(human event.ID) *protocol.Client {
		return connectServerAs(t, handler, host, human, protocol.Capabilities{})
	}
	p := profile.DefaultLeader()
	p.ID, p.Model.Provider = "leader-profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Paused", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"}, {ID: "observer", Name: "Observer", Kind: group.MemberHuman, Role: "observer"}, {ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: p.ID}}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	if err := as("observer").Call(ctx, "group.pause", map[string]any{"group": g.ID}, new(struct{})); err == nil {
		t.Fatal("observer paused the group")
	}
	if err := as("owner").Call(ctx, "group.pause", map[string]any{"group": g.ID}, new(struct{})); err != nil {
		t.Fatal(err)
	}
	events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{loop.TurnStarted, loop.TurnFinished}})
	defer stop()
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Keep this message"}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-events:
		t.Fatalf("paused group invoked a model: %s", fact.Type)
	case <-time.After(80 * time.Millisecond):
	}
	if err := as("owner").Call(ctx, "group.resume", map[string]any{"group": g.ID}, new(struct{})); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-events:
			if fact.Type == loop.TurnFinished {
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
