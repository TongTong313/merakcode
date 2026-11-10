package server_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
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
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Codes", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var defaults []profile.Profile
	if err := client.Call(ctx, "profile.list", map[string]any{"human": "owner"}, &defaults); err != nil {
		t.Fatal(err)
	}
	leaderProfile, workerProfile := defaults[0], defaults[1]
	var owned profile.Profile
	draft := workerProfile
	draft.ID, draft.Name = "", "Codes worker"
	if err := client.Call(ctx, "profile.save", map[string]any{"human": "owner", "profile": draft}, &owned); err != nil {
		t.Fatal(err)
	}
	worker := group.Member{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: owned.ID}
	if err := client.Call(ctx, "group.addMember", map[string]any{"group": g.ID, "human": "owner", "member": worker}, new(group.Member)); err != nil {
		t.Fatal(err)
	}
	external := workerProfile
	external.ID, external.Role, external.ToolPool = "", profile.Leader, "leader.default"
	external.Product = &profile.Product{Kind: "command", Binary: "node"}
	edited := owned
	edited.Name = "Edited by someone else"
	for _, test := range []struct {
		name, method string
		params       map[string]any
		code         string
	}{
		{"a worker member with a leader profile", "group.addMember", map[string]any{"group": g.ID, "human": "owner", "member": group.Member{ID: "extra", Name: "Extra", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: leaderProfile.ID}}, "MRK-6003"},
		{"a worker member with a leader draft", "group.addMember", map[string]any{"group": g.ID, "human": "owner", "member": group.Member{ID: "extra", Name: "Extra", Kind: group.MemberAgent, AgentRole: group.AgentWorker}, "profile": leaderProfile}, "MRK-6003"},
		{"a target branch outside a repository", "group.create", map[string]any{"name": "Branch", "kind": "local", "project": group.Project{Directory: t.TempDir()}, "brief": group.Brief{TargetBranch: "main"}, "defaultLeader": "leader", "members": []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: "owner"}}, "profiles": []profile.Profile{}}, "MRK-6006"},
		{"an external leader without MCP and steering", "profile.save", map[string]any{"human": "owner", "profile": external}, "MRK-6007"},
		{"deleting a profile that is still in a group", "profile.delete", map[string]any{"human": "owner", "profile": owned.ID}, "MRK-6004"},
		{"editing a profile owned by someone else", "profile.save", map[string]any{"human": "other", "profile": edited}, "MRK-6005"},
		{"deleting a profile owned by someone else", "profile.delete", map[string]any{"human": "other", "profile": owned.ID}, "MRK-6005"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var failure *protocol.Error
			if err := client.Call(ctx, test.method, test.params, nil); !errors.As(err, &failure) || failure.Data.Code != test.code {
				t.Fatalf("err=%v want %s", err, test.code)
			}
		})
	}
}
