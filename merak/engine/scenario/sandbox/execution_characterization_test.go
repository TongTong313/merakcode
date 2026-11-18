package sandbox_test

import (
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestMemberSandboxStatusChecksTheSavedSessionGroupAndMember(t *testing.T) {
	ctx := t.Context()
	directory := t.TempDir()
	provider := enginetest.GroupScript{ProviderName: "fixture", Test: t, Reply: func(model.Request) fake.Reply {
		return fake.Reply{Text: "Waiting."}
	}}
	deps2 := enginetest.Deps(t)
	deps2.Workdir = directory
	deps2.Providers = map[string]model.Provider{"fixture": provider}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, work.ID = "leader-profile", "worker-profile"
	lead.Model.Provider, work.Model.Provider = "fixture", "fixture"
	members := []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}
	first, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "First", Leader: "leader", Project: group.Project{Directory: directory}}, members, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Second", Leader: "leader", Project: group.Project{Directory: directory}}, members)
	if err != nil {
		t.Fatal(err)
	}
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Scope: event.Scope{Group: first.ID}, Member: "worker", Provider: "fixture", Workdir: directory, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		group  event.ID
		member event.ID
		code   string
	}{
		{"saved member", first.ID, "worker", ""},
		{"another member", first.ID, "leader", "MRK-6001"},
		{"another group", second.ID, "worker", "MRK-6001"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, err := e.MemberSandboxStatus(ctx, tc.group, tc.member, id)
			if tc.code != "" {
				if err == nil || err.Error() != tc.code {
					t.Fatalf("session outside the requested member: status=%+v error=%v, want %s", status, err, tc.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !status.Disabled || status.Available || status.Backend != "none" || status.Network != "none" {
				t.Fatalf("saved member takeover status=%+v", status)
			}
		})
	}
}

func TestSandboxStatusUsesTheSavedWorkspaceAndMode(t *testing.T) {
	for _, tc := range []struct {
		name        string
		savedMode   permission.Mode
		requestMode permission.Mode
		disabled    bool
		restart     bool
	}{
		{"saved normal mode", permission.ModeAsk, permission.ModeTakeover, false, false},
		{"saved takeover mode", permission.ModeTakeover, permission.ModeAsk, true, false},
		{"saved takeover after restart", permission.ModeTakeover, permission.ModeAsk, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			other, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			enginetest.FixtureGit(t, directory, "init", "--quiet")
			deps := enginetest.Deps(t)
			deps.Store = memory.New()
			deps.Providers = map[string]model.Provider{"fixture": fake.New(t)}

			e, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fixture", Workdir: directory, Mode: tc.savedMode})
			if err != nil {
				t.Fatal(err)
			}
			if tc.restart {
				if err := e.Shutdown(ctx); err != nil {
					t.Fatal(err)
				}
				e, err = engine.New(deps)
				if err != nil {
					t.Fatal(err)
				}
				defer e.Close()
			}
			status, err := e.SandboxStatus(ctx, other, tc.requestMode, id)
			if err != nil {
				t.Fatal(err)
			}
			if status.Disabled != tc.disabled {
				t.Fatalf("saved session disabled=%v, want %v", status.Disabled, tc.disabled)
			}
			if tc.disabled {
				if status.Available || status.Backend != "none" || status.Network != "none" {
					t.Fatalf("saved takeover status=%+v", status)
				}
				return
			}
			config := filepath.Join(directory, ".git", "config")
			found := false
			for _, protection := range status.Protect {
				if protection.Path == filepath.Join(other, ".git", "config") {
					t.Fatalf("status protects the request directory instead of the saved workspace: %+v", status)
				}
				if protection.Path == config {
					found = true
				}
			}
			if !found {
				t.Fatalf("saved workspace config %s is absent from protection status: %+v", config, status)
			}
		})
	}
}
