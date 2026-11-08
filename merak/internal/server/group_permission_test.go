package server_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

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
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "fixture-token", protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}, Capabilities: protocol.Capabilities{Approve: true}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	lead := profile.DefaultLeader()
	lead.ID, lead.Model.Provider = "lead-profile", "fake"
	p := profile.DefaultWorker()
	p.ID, p.Model.Provider = "worker-profile", "fake"
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: dir}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, p})
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
			params := protocol.PermissionReplyParams{Request: fact.ID, Decision: permission.Allow, Human: "approver"}
			if err := client.Call(ctx, "permission.reply", params, nil); err == nil {
				t.Fatal("lower role answered a protected write")
			}
			params.Human = "owner"
			if err := client.Call(ctx, "permission.reply", params, nil); err != nil {
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
