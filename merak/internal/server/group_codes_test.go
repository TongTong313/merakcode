package server_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestGroupAndProfileFailuresCarryTheirOwnCodes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
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
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Codes", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var defaults []agent.Agent
	if err := as("owner").Call(ctx, "agent.list", struct{}{}, &defaults); err != nil {
		t.Fatal(err)
	}
	workerProfile := defaults[0]
	var owned agent.Agent
	draft := workerProfile
	draft.ID, draft.Name = "", "Codes worker"
	if err := as("owner").Call(ctx, "agent.save", map[string]any{"agent": draft}, &owned); err != nil {
		t.Fatal(err)
	}
	worker := group.Member{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: owned.ID}
	if err := as("owner").Call(ctx, "group.addMember", map[string]any{"group": g.ID, "member": worker}, new(group.Member)); err != nil {
		t.Fatal(err)
	}
	external := workerProfile
	external.ID, external.Name = "", "Command agent"
	external.Product = &agent.Product{Kind: "command", Binary: "node"}
	// Any agent can be saved; whether it can lead is decided when it is given the Leader seat.
	var savedExternal agent.Agent
	if err := as("owner").Call(ctx, "agent.save", map[string]any{"agent": external}, &savedExternal); err != nil {
		t.Fatal(err)
	}
	edited := owned
	edited.Name = "Edited by someone else"
	for _, test := range []struct {
		name, method, human string
		params              map[string]any
		code                string
	}{
		{"a target branch outside a repository", "group.create", "owner", map[string]any{"name": "Branch", "kind": "local", "project": group.Project{Directory: t.TempDir()}, "brief": group.Brief{TargetBranch: "main"}, "leader": "leader", "members": []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"}}}, "MRK-6006"},
		{"an external leader without MCP and steering", "group.update", "owner", map[string]any{"group": g.ID, "leader": savedExternal.ID}, "MRK-6007"},
		{"deleting a profile that is still in a group", "agent.delete", "owner", map[string]any{"agent": owned.ID}, "MRK-6004"},
		{"editing a profile owned by someone else", "agent.save", "other", map[string]any{"agent": edited}, "MRK-6005"},
		{"deleting a profile owned by someone else", "agent.delete", "other", map[string]any{"agent": owned.ID}, "MRK-6005"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var failure *protocol.Error
			if err := as(event.ID(test.human)).Call(ctx, test.method, test.params, nil); !errors.As(err, &failure) || failure.Data.Code != test.code {
				t.Fatalf("err=%v want %s", err, test.code)
			}
		})
	}
}
