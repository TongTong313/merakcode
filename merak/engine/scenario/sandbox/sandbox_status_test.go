package sandbox_test

import (
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestIdleGroupMemberSandboxUsesItsEffectiveProfile(t *testing.T) {
	ctx := t.Context()
	directory := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = directory
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID = "leader-profile"
	work.ID = "private-profile"
	work.Mode = permission.ModeTakeover
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Name: "Inline", Kind: group.KindLocal, Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	status, err := e.MemberSandboxStatus(ctx, g.ID, "worker", "")
	if err != nil {
		t.Fatal(err)
	}
	if !status.Disabled {
		t.Fatalf("sandbox=%+v", status)
	}
}

func TestSandboxStatusResolvesProtectionInALinkedWorktree(t *testing.T) {
	root := t.TempDir()
	enginetest.FixtureGit(t, root, "init", "--quiet")
	enginetest.FixtureGit(t, root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "--quiet", "-m", "Initial")
	worktree := filepath.Join(t.TempDir(), "linked")
	enginetest.FixtureGit(t, root, "worktree", "add", "--quiet", "--detach", worktree)
	deps2 := enginetest.Deps(t)
	deps2.Workdir = worktree
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	status, err := e.SandboxStatus(t.Context(), "", permission.ModeAsk)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(root, ".git", "hooks"), filepath.Join(root, ".git", "config")} {
		found := false
		for _, protection := range status.Protect {
			if protection.Path == path {
				found = true
				if protection.State == "missing" || protection.State == "unknown" {
					t.Errorf("existing Git protection reported %s: %s", protection.State, path)
				}
			}
		}
		if !found {
			t.Errorf("Git protection is missing: %s; status=%+v", path, status)
		}
	}
}
