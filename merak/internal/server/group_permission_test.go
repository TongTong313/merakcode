package server_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOfflineWorkspaceConfirmationSurvivesTheTurnAndClientDisconnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(`{"mcp":{"docs":{"type":"local","command":["not-started"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	settings := config.NewMemory()
	var handler *server.Server
	e, err := engine.New(engine.Deps{Workdir: directory, NetworkSettings: settings, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Finished"})}, Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		return handler.Ask(ctx, req)
	}})
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "fixture")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{"turn.finished"}})
	defer stop()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Continue"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("confirmation blocked the turn")
	}
	connect := func() *protocol.Client {
		t.Helper()
		client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "fixture", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
		if err != nil {
			t.Fatal(err)
		}
		return client
	}
	var request event.ID
	for attempt := range 2 {
		client := connect()
		defer client.Close()
		for {
			select {
			case fact := <-client.Events:
				if fact.Type != permission.Requested {
					continue
				}
				if attempt == 0 {
					request = fact.ID
					client.Close()
				} else {
					if fact.ID != request {
						t.Fatal("confirmation identity changed")
					}
					if err := client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: request, Decision: permission.Allow}, nil); err != nil {
						t.Fatal(err)
					}
				}
			case <-ctx.Done():
				t.Fatal("workspace confirmation was lost")
			}
			break
		}
	}
	for len(settings.Private().WorkspaceTrust) != 1 {
		select {
		case <-ctx.Done():
			t.Fatal("confirmation answer was not persisted")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestGroupApprovalRejectsAnUnqualifiedHumanWithoutConsumingTheRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	var handler *server.Server
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"merakcode.json","content":"verified"}`)}}}, fake.Reply{Text: "Finished"})
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}, Ask: func(ctx context.Context, r permission.Request) (permission.Reply, error) { return handler.Ask(ctx, r) }})
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "fixture-token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), handler.AddIdentity("approver"), protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	lead := agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "fake"
	p := agent.DefaultMerakCode()
	p.ID, p.Model.Provider = "worker-profile", "fake"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []agent.Agent{lead, p})
	if err != nil {
		t.Fatal(err)
	}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: event.NewID(), Workdir: dir, Scope: event.Scope{Group: g.ID}, Packet: "Write", Claim: task.Claim{ID: "claim", Member: "worker"}})
	if err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-client.Events:
			if fact.Type != permission.Requested {
				continue
			}
			params := protocol.PermissionReplyParams{Request: fact.ID, Decision: permission.Allow}
			if err := client.Call(ctx, "permission.reply", params, nil); err == nil {
				t.Fatal("lower role answered a protected write")
			}
			client.Close()
			owner, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), handler.AddIdentity("owner"), protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
			if err != nil {
				t.Fatal(err)
			}
			defer owner.Close()
			waitForRequest(t, owner, fact.ID)
			if err := owner.Call(ctx, "permission.reply", params, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := run.Wait(ctx); err != nil {
				t.Fatal(err)
			}
			body, err := os.ReadFile(filepath.Join(dir, "merakcode.json"))
			if err != nil || string(body) != "verified" {
				t.Fatalf("file=%s err=%v", body, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestOfflineGroupApprovalWaitsForAConnectingHuman(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	directory := t.TempDir()
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"result.txt","content":"approved"}`)}}}, fake.Reply{Text: "Finished"})
	var handler *server.Server
	e, err := engine.New(engine.Deps{Workdir: directory, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		return handler.Ask(ctx, req)
	}})
	if err != nil {
		t.Fatal(err)
	}
	handler = server.New(e, "token")
	ownerToken := handler.AddIdentity("owner")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	lead, workerProfile := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "fixture"
	workerProfile.ID, workerProfile.Model.Provider = "worker-profile", "fixture"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: workerProfile.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []agent.Agent{lead, workerProfile})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{permission.Requested}})
	defer stop()
	run, err := e.StartWorker(ctx, workerProfile, worker.Assignment{Session: event.NewID(), Workdir: directory, Scope: event.Scope{Group: g.ID}, Packet: "Write", Claim: task.Claim{ID: "claim", Member: "worker"}})
	if err != nil {
		t.Fatal(err)
	}
	var request event.ID
	select {
	case fact := <-facts:
		request = fact.ID
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), ownerToken, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	transferred := false
	for {
		select {
		case fact := <-client.Events:
			if fact.Type != permission.Requested {
				continue
			}
			if fact.ID != request {
				t.Fatal("reconnect changed request identity")
			}
			if !transferred {
				replacement, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), ownerToken, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "replacement", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
				if err != nil {
					t.Fatal(err)
				}
				defer replacement.Close()
				time.Sleep(100 * time.Millisecond)
				client.Close()
				client, transferred = replacement, true
				continue
			}
			if err := client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: request, Decision: permission.Allow}, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := run.Wait(ctx); err != nil {
				t.Fatal(err)
			}
			body, err := os.ReadFile(filepath.Join(directory, "result.txt"))
			if err != nil || string(body) != "approved" {
				t.Fatalf("file=%q err=%v", body, err)
			}
			return
		case <-ctx.Done():
			t.Fatal("pending group approval was not offered to the connecting human")
		}
	}
}
