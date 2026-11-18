package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestSDKTaskBudgetIncreaseRequiresOwnerAndPreservesDeniedState(t *testing.T) {
	for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
		t.Run(string(decision), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var host *server.Instance
			asked := make(chan permission.Request, 1)
			deps := enginetest.Deps(t)
			deps.Providers = map[string]model.Provider{
				"worker": fake.New(t, fake.Reply{Text: "Budget used", Usage: &model.Usage{Input: 11}}),
				"leader": fake.New(t, fake.Reply{Hold: make(chan struct{})}),
			}
			deps.Ask = func(ctx context.Context, req permission.Request) (permission.Reply, error) {
				asked <- req
				return host.Ask(ctx, req)
			}
			e, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			host, err = server.Start(e, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer host.Close()
			owner := connectAs(t, host, "owner", protocol.Capabilities{})
			admin := connectAs(t, host, "admin", protocol.Capabilities{})
			adminApprover := connectAs(t, host, "admin", protocol.Capabilities{Approve: true})
			lead := definition.DefaultMerakCode()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			if _, err := e.SaveAgent(ctx, "owner", lead); err != nil {
				t.Fatal(err)
			}
			work := definition.DefaultMerakCode()
			work.ID, work.Model.Provider, work.Mode = "worker-profile", "worker", permission.ModeTakeover
			if _, err := e.SaveAgent(ctx, "owner", work); err != nil {
				t.Fatal(err)
			}
			g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Budget", Leader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
			})
			if err != nil {
				t.Fatal(err)
			}
			var card task.Card
			if err := owner.Call(ctx, "task.create", map[string]any{"group": g.ID, "title": "Bounded", "workspace": "none", "budget": map[string]any{"maxTokens": 10}}, &card); err != nil {
				t.Fatal(err)
			}
			if card.Budget.MaxTokens != 10 {
				t.Fatalf("created budget=%+v", card.Budget)
			}
			reports, stopReports := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID, Task: card.ID}, Types: []event.Type{task.Reported}})
			defer stopReports()
			if _, err := e.AssignTask(ctx, card.ID, "owner", "worker", task.RoleOwner, nil); err != nil {
				t.Fatal(err)
			}
			select {
			case <-reports:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if blocked, err := e.Task(ctx, card.ID); err != nil || blocked.Status != task.Blocked {
				t.Fatalf("worker did not exhaust the task budget: %+v %v", blocked, err)
			}
			completed := make(chan error, 1)
			go func() {
				completed <- admin.Call(ctx, "task.update", map[string]any{"task": card.ID, "budget": map[string]any{"tokens": 20}, "reason": "Finish verification"}, nil)
			}()
			var request permission.Request
			select {
			case request = <-asked:
			case err := <-completed:
				t.Fatalf("budget did not ask owner: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if request.Kind != "budget" || approval.Need(request, workspace.Workspace{}, g) != group.RoleOwner || request.Leader != "" {
				t.Fatalf("route=%+v", request)
			}
			waitForRequest(t, adminApprover, request.ID)
			if err := adminApprover.Call(ctx, "permission.reply", wire.PermissionReplyParams{Request: request.ID, Decision: decision}, nil); err == nil {
				t.Fatal("admin approved an owner budget")
			}
			adminApprover.Close()
			ownerApprover := connectAs(t, host, "owner", protocol.Capabilities{Approve: true})
			waitForRequest(t, ownerApprover, request.ID)
			if err := ownerApprover.Call(ctx, "permission.reply", wire.PermissionReplyParams{Request: request.ID, Decision: decision}, nil); err != nil {
				t.Fatal(err)
			}
			err = <-completed
			if decision == permission.Allow && err != nil || decision == permission.Deny && err == nil {
				t.Fatalf("decision=%s error=%v", decision, err)
			}
			current, _ := e.Task(ctx, card.ID)
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
			if err := owner.Call(ctx, "task.update", map[string]any{"task": card.ID, "budget": map[string]any{"tokens": 15}}, nil); err != nil {
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
	deps2 := enginetest.Deps(t)
	deps2.Providers = map[string]model.Provider{"fixture": provider}
	e, err := engine.New(deps2)
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
	if err := client.Call(ctx, "session.create", map[string]any{"workdir": t.TempDir(), "provider": "fixture", "budget": map[string]any{"maxTokens": 10}}, &created); err != nil {
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
