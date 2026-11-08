package workspace_test

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func command(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := process.Command(context.Background(), dir, "git", args...)
	body, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, body)
	}
	return strings.TrimSpace(string(body))
}
func repository(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				_ = os.Chmod(path, 0600)
			}
			return nil
		})
	})
	command(t, dir, "init", "-b", "main")
	command(t, dir, "config", "user.name", "Fixture")
	command(t, dir, "config", "user.email", "fixture@example.invalid")
	command(t, dir, "config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("Baseline\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command(t, dir, "add", ".")
	command(t, dir, "commit", "-m", "Fixture baseline")
	return dir
}

func TestClaimWorkspaceIsExcludedPersistedIntegratedAndReleased(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := repository(t)
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := workspace.New(ctx, storage, bus, event.NewID)
	defer manager.Close()
	base, _ := git.Current(ctx, repo)
	card := task.Card{ID: "task", Group: "group", Title: "Add result", Workspace: workspace.KindWorktree, Base: base}
	claim := task.Claim{ID: "claim", Task: card.ID, Member: "member", Status: task.ClaimActive, Session: "session"}
	ws, err := manager.ForClaim(ctx, repo, claim, card)
	if err != nil {
		t.Fatal(err)
	}
	if ws.Directory != filepath.Join(repo, ".merak", "worktrees", "task-member") || ws.Branch != "merak/task/member" || ws.Base != base {
		t.Fatalf("workspace=%+v", ws)
	}
	status, err := git.Status(ctx, repo)
	if err != nil || len(status.Files) != 0 {
		t.Fatalf("worktree leaked into project status: %+v %v", status, err)
	}
	restored, err := manager.Get(ctx, ws.ID)
	if err != nil || restored.Directory != ws.Directory {
		t.Fatalf("restored=%+v err=%v", restored, err)
	}
	if err := os.WriteFile(filepath.Join(ws.Directory, "result.txt"), []byte("Verified\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command(t, ws.Directory, "add", "result.txt")
	command(t, ws.Directory, "commit", "-m", "Worker result fixture")
	owned := strings.TrimSpace(command(t, ws.Directory, "rev-parse", "HEAD"))
	result, err := manager.Integrate(ctx, ws, "main", "")
	if err != nil || len(result.Conflicts) != 0 || result.Head == "" {
		t.Fatalf("integration=%+v err=%v", result, err)
	}
	if len(result.Commits) != 1 || result.Commits[0] != owned {
		t.Fatalf("owned commits=%v want=%s", result.Commits, owned)
	}
	body, err := os.ReadFile(filepath.Join(repo, "result.txt"))
	if err != nil || string(body) != "Verified\n" {
		t.Fatalf("result=%q err=%v", body, err)
	}
	if err := manager.Release(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ws.Directory); !os.IsNotExist(err) {
		t.Fatalf("worktree was not removed: %v", err)
	}
}

func TestWorktreeCreationRejectsARepositorySubdirectory(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	dir := filepath.Join(repo, "nested")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	storage := memory.New()
	manager := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	_, err := manager.ForClaim(ctx, dir, task.Claim{ID: "claim", Task: "task", Member: "member"}, task.Card{ID: "task", Group: "group", Workspace: workspace.KindWorktree, Base: "HEAD"})
	if err == nil {
		t.Fatal("subdirectory claimed its parent repository")
	}
	if branches := command(t, repo, "branch", "--format=%(refname:short)"); branches != "main" {
		t.Fatalf("branches=%s", branches)
	}
}
