package engine_test

import (
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/permission"
)

func TestSandboxStatusResolvesProtectionInALinkedWorktree(t *testing.T) {
	root := t.TempDir()
	fixtureGit(t, root, "init", "--quiet")
	fixtureGit(t, root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "--quiet", "-m", "Initial")
	worktree := filepath.Join(t.TempDir(), "linked")
	fixtureGit(t, root, "worktree", "add", "--quiet", "--detach", worktree)
	e, err := engine.New(engine.Deps{Workdir: worktree})
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
