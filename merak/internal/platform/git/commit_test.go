package git_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func TestCommitRecordsTheChosenFilesOrEverythingAndLogShowsIt(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	write(t, repo, "note.txt", "changed\n")
	write(t, repo, "other.txt", "other\n")
	write(t, repo, "third.txt", "third\n")

	commit, err := git.CommitChanges(ctx, repo, "Change the note", []string{"note.txt"})
	if err != nil || commit == "" {
		t.Fatalf("commit=%q err=%v", commit, err)
	}
	if subject := strings.TrimSpace(command(t, repo, "log", "-1", "--format=%s")); subject != "Change the note" {
		t.Fatalf("subject=%q", subject)
	}
	if files := strings.Fields(command(t, repo, "show", "--name-only", "--format=", "HEAD")); len(files) != 1 || files[0] != "note.txt" {
		t.Fatalf("the commit holds %v, want only note.txt", files)
	}
	if status := command(t, repo, "status", "--porcelain"); !strings.Contains(status, "other.txt") || !strings.Contains(status, "third.txt") {
		t.Fatalf("the files that were not chosen are not left alone: %q", status)
	}

	if _, err := git.CommitChanges(ctx, repo, "Everything else", nil); err != nil {
		t.Fatal(err)
	}
	if status := strings.TrimSpace(command(t, repo, "status", "--porcelain")); status != "" {
		t.Fatalf("a commit of everything left %q", status)
	}
	if _, err := git.CommitChanges(ctx, repo, "Nothing", nil); err == nil {
		t.Fatal("an empty commit was made")
	}
	if _, err := git.CommitChanges(ctx, repo, "   ", nil); err == nil {
		t.Fatal("a commit without a message was made")
	}
	write(t, repo, "note.txt", "again\n")
	if _, err := git.CommitChanges(ctx, repo, "Escape", []string{"../outside.txt"}); err == nil {
		t.Fatal("a path outside the repository was accepted")
	}
}

func TestStagedDiffTextAndPushToABareRemote(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	remote := filepath.Join(t.TempDir(), "remote.git")
	command(t, filepath.Dir(remote), "init", "--bare", "-b", "main", remote)
	command(t, repo, "remote", "add", "origin", remote)

	write(t, repo, "note.txt", "staged line\n")
	command(t, repo, "add", "note.txt")
	text, err := git.StagedDiff(ctx, repo)
	if err != nil || !strings.Contains(text, "+staged line") || !strings.Contains(text, "note.txt") {
		t.Fatalf("staged diff=%q err=%v", text, err)
	}
	if _, err := git.CommitChanges(ctx, repo, "Staged change", nil); err != nil {
		t.Fatal(err)
	}
	if err := git.Push(ctx, repo); err != nil {
		t.Fatal(err)
	}
	local, err := git.Current(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(command(t, remote, "rev-parse", "refs/heads/main")); got != local {
		t.Fatalf("the remote has %s, want %s", got, local)
	}
	write(t, repo, "later.txt", "more\n")
	if _, err := git.CommitChanges(ctx, repo, "Second", nil); err != nil {
		t.Fatal(err)
	}
	if err := git.Push(ctx, repo); err != nil {
		t.Fatalf("a second push: %v", err)
	}
	command(t, repo, "remote", "remove", "origin")
	if err := git.Push(ctx, repo); err == nil {
		t.Fatal("a push without a remote succeeded")
	}
}

func TestWorktreesAreListedWithTheirBranch(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	base, err := git.Current(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if err := git.CreateBranch(ctx, repo, "side", base); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "side-tree")
	if err := git.AddWorktree(ctx, repo, dir, "side"); err != nil {
		t.Fatal(err)
	}
	trees, err := git.Worktrees(ctx, repo)
	if err != nil || len(trees) != 2 {
		t.Fatalf("worktrees=%+v err=%v", trees, err)
	}
	var found bool
	for _, tree := range trees {
		if tree.Branch == "side" && filepath.Base(tree.Path) == "side-tree" && !tree.Main {
			found = true
		}
		if tree.Main && tree.Branch != "main" {
			t.Errorf("the main worktree is on %q", tree.Branch)
		}
	}
	if !found {
		t.Fatalf("the linked worktree is missing: %+v", trees)
	}
}
