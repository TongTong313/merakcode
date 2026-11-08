package git_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func TestWorktreeRebasesAndFastForwardsWithoutChangingTheTargetOnConflict(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		name := "fast forward"
		if conflict {
			name = "conflict"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			repo := repository(t)
			base, err := git.Current(ctx, repo)
			if err != nil {
				t.Fatal(err)
			}
			if err := git.CreateBranch(ctx, repo, "worker", base); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(t.TempDir(), "worktree")
			if err := git.AddWorktree(ctx, repo, dir, "worker"); err != nil {
				t.Fatal(err)
			}
			write(t, dir, "note.txt", "worker result\n")
			command(t, dir, "add", "note.txt")
			command(t, dir, "commit", "-m", "Worker fixture")
			beforeWorker, err := git.Current(ctx, dir)
			if err != nil {
				t.Fatal(err)
			}
			file := "upstream.txt"
			if conflict {
				file = "note.txt"
			}
			write(t, repo, file, "upstream result\n")
			command(t, repo, "add", file)
			command(t, repo, "commit", "-m", "Upstream fixture")
			beforeTarget, err := git.Current(ctx, repo)
			if err != nil {
				t.Fatal(err)
			}
			if conflict {
				if err := git.FastForward(ctx, repo, "main", "worker"); err == nil {
					t.Fatal("divergent target was rewritten")
				}
			}
			files, err := git.Rebase(ctx, dir, "main")
			if err != nil {
				t.Fatal(err)
			}
			if conflict {
				if !reflect.DeepEqual(files, []string{"note.txt"}) {
					t.Fatalf("conflicts=%v", files)
				}
				target, _ := git.Current(ctx, repo)
				worker, _ := git.Current(ctx, dir)
				if target != beforeTarget || worker != beforeWorker {
					t.Fatal("conflict rewrote a branch")
				}
				return
			}
			if len(files) != 0 {
				t.Fatalf("conflicts=%v", files)
			}
			if err := git.FastForward(ctx, repo, "main", "worker"); err != nil {
				t.Fatal(err)
			}
			for file, want := range map[string]string{"note.txt": "worker result\n", "upstream.txt": "upstream result\n"} {
				body, err := os.ReadFile(filepath.Join(repo, file))
				if err != nil || string(body) != want {
					t.Fatalf("file=%s body=%q err=%v", file, body, err)
				}
			}
			target, _ := git.Current(ctx, repo)
			worker, _ := git.Current(ctx, dir)
			if target != worker {
				t.Fatal("target did not fast-forward to the rebased worker")
			}
		})
	}
}

func TestRebaseDoesNotDiscardAnExistingConflictResolution(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	if err := git.CreateBranch(ctx, repo, "worker", "HEAD"); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "worker")
	if err := git.AddWorktree(ctx, repo, dir, "worker"); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "note.txt", "worker\n")
	command(t, dir, "add", "note.txt")
	command(t, dir, "commit", "-m", "Worker fixture")
	write(t, repo, "note.txt", "target\n")
	command(t, repo, "add", "note.txt")
	command(t, repo, "commit", "-m", "Target fixture")
	cmd := exec.Command("git", "rebase", "main")
	cmd.Dir = dir
	if err := cmd.Run(); err == nil {
		t.Fatal("fixture did not conflict")
	}
	write(t, dir, "note.txt", "resolution in progress\n")
	if _, err := git.Rebase(ctx, dir, "main"); err == nil {
		t.Fatal("existing rebase was treated as a new integration")
	}
	body, err := os.ReadFile(filepath.Join(dir, "note.txt"))
	if err != nil || string(body) != "resolution in progress\n" {
		t.Fatalf("resolution=%q err=%v", body, err)
	}
}

func TestFastForwardPreservesTheUsersSelectedBranch(t *testing.T) {
	for _, checkedOut := range []bool{false, true} {
		name := "target not checked out"
		if checkedOut {
			name = "target in another worktree"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			repo := repository(t)
			base, _ := git.Current(ctx, repo)
			for _, branch := range []string{"worker", "delivery"} {
				if err := git.CreateBranch(ctx, repo, branch, base); err != nil {
					t.Fatal(err)
				}
			}
			workerDir := filepath.Join(t.TempDir(), "worker")
			if err := git.AddWorktree(ctx, repo, workerDir, "worker"); err != nil {
				t.Fatal(err)
			}
			write(t, workerDir, "note.txt", "delivered\n")
			command(t, workerDir, "add", "note.txt")
			command(t, workerDir, "commit", "-m", "Delivery fixture")
			var targetDir string
			if checkedOut {
				targetDir = filepath.Join(t.TempDir(), "target")
				if err := git.AddWorktree(ctx, repo, targetDir, "delivery"); err != nil {
					t.Fatal(err)
				}
			}
			if err := git.FastForward(ctx, repo, "delivery", "worker"); err != nil {
				t.Fatal(err)
			}
			status, err := git.Status(ctx, repo)
			if err != nil || status.Branch != "main" || status.Head != base {
				t.Fatalf("user worktree=%+v err=%v", status, err)
			}
			if checkedOut {
				body, err := os.ReadFile(filepath.Join(targetDir, "note.txt"))
				if err != nil || string(body) != "delivered\n" {
					t.Fatalf("target=%q err=%v", body, err)
				}
			}
			if command(t, repo, "rev-parse", "delivery") != command(t, repo, "rev-parse", "worker") {
				t.Fatal("target branch did not advance")
			}
		})
	}
}
