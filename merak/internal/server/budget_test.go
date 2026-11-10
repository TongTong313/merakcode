package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestSDKTaskBudgetIncreaseRequiresOwnerAndPreservesDeniedState(t *testing.T) {
	for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
		t.Run(string(decision), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var host *server.Instance
			asked := make(chan permission.Request, 1)
			e, err := engine.New(engine.Deps{Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
				asked <- req
				return host.Ask(ctx, req)
			}})
			if err != nil {
				t.Fatal(err)
			}
			host, err = server.Start(e, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: 1, Capabilities: protocol.Capabilities{Approve: true}})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Budget", DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
			})
			if err != nil {
				t.Fatal(err)
			}
			var card task.Card
			if err := client.Call(ctx, "task.create", map[string]any{"group": g.ID, "human": "owner", "title": "Bounded", "budget": map[string]any{"maxTokens": 10}}, &card); err != nil {
				t.Fatal(err)
			}
			if card.Budget.MaxTokens != 10 {
				t.Fatalf("created budget=%+v", card.Budget)
			}
			if err := e.Tasks.Block(ctx, card.ID); err != nil {
				t.Fatal(err)
			}
			completed := make(chan error, 1)
			go func() {
				completed <- client.Call(ctx, "task.update", map[string]any{"task": card.ID, "human": "admin", "budget": map[string]any{"tokens": 20}, "reason": "Finish verification"}, nil)
			}()
			var request permission.Request
			select {
			case request = <-asked:
			case err := <-completed:
				t.Fatalf("budget did not ask owner: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if request.Kind != "budget" || permission.Need(request, workspace.Workspace{}, g) != group.RoleOwner || request.Leader != "" {
				t.Fatalf("route=%+v", request)
			}
			if err := client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: request.ID, Human: "admin", Decision: decision}, nil); err == nil {
				t.Fatal("admin approved an owner budget")
			}
			if err := client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: request.ID, Human: "owner", Decision: decision}, nil); err != nil {
				t.Fatal(err)
			}
			err = <-completed
			if decision == permission.Allow && err != nil || decision == permission.Deny && err == nil {
				t.Fatalf("decision=%s error=%v", decision, err)
			}
			current, _ := e.Tasks.Get(ctx, card.ID)
			body, _ := json.Marshal(current)
			var value struct {
				Grants []struct {
					Tokens int
					By     event.Actor
				}
			}
			_ = json.Unmarshal(body, &value)
			if decision == permission.Allow {
				if len(value.Grants) != 1 || value.Grants[0].Tokens != 20 || value.Grants[0].By.ID != "owner" || current.Status == task.Blocked {
					t.Fatalf("approved=%s", body)
				}
			} else if len(value.Grants) != 0 || current.Status != task.Blocked {
				t.Fatalf("denied=%s", body)
			}
			if err := client.Call(ctx, "task.update", map[string]any{"task": card.ID, "human": "owner", "budget": map[string]any{"tokens": 15}}, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSDKChatRequiresExplicitBudgetExtension(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	release, started := make(chan struct{}), make(chan struct{})
	provider := fake.New(t, fake.Reply{Text: "First", Usage: &model.Usage{Input: 11}}, fake.Reply{Text: "Second", Hold: release, Expect: func(model.Request) error { close(started); return nil }, Usage: &model.Usage{Input: 11}})
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fixture": provider}})
	if err != nil {
		t.Fatal(err)
	}
	host, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	client, err := protocol.Connect(ctx, host.Info.Endpoint, host.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Call(ctx, "events.subscribe", event.Filter{Types: []event.Type{loop.TurnFinished}}, nil); err != nil {
		t.Fatal(err)
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", map[string]any{"provider": "fixture", "budget": map[string]any{"maxTokens": 10}}, &created); err != nil {
		t.Fatal(err)
	}
	send := func(extend bool) error {
		return client.Call(ctx, "session.send", map[string]any{"session": created.Session, "parts": []model.Part{{Text: "Continue"}}, "extendBudget": extend}, nil)
	}
	finished := func() {
		t.Helper()
		select {
		case fact := <-client.Events:
			outcome, err := event.Decode[loop.Outcome](fact)
			if err != nil || outcome.Stop != loop.MaxTokens || outcome.Code != "MRK-4005" {
				t.Fatalf("outcome=%+v %v", outcome, err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if err := send(false); err != nil {
		t.Fatal(err)
	}
	finished()
	if err := send(false); err == nil || err.Error() != "MRK-4005" {
		t.Fatalf("unapproved extension=%v", err)
	}
	if err := send(true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := send(true); err == nil || err.Error() != "MRK-4005" {
		t.Fatalf("duplicate budget extension=%v", err)
	}
	close(release)
	finished()
}
