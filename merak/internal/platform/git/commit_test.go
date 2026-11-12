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

func TestStagingMovesFilesInAndOutOfTheIndexAndAStagedCommitRecordsOnlyThem(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	write(t, repo, "note.txt", "changed\n")
	write(t, repo, "other.txt", "other\n")

	if err := git.Stage(ctx, repo, []string{"note.txt", "other.txt"}); err != nil {
		t.Fatal(err)
	}
	if staged := strings.Fields(command(t, repo, "diff", "--cached", "--name-only")); len(staged) != 2 {
		t.Fatalf("staged=%v", staged)
	}
	if err := git.Unstage(ctx, repo, []string{"other.txt"}); err != nil {
		t.Fatal(err)
	}
	if staged := strings.Fields(command(t, repo, "diff", "--cached", "--name-only")); len(staged) != 1 || staged[0] != "note.txt" {
		t.Fatalf("staged=%v", staged)
	}
	if _, err := git.CommitStaged(ctx, repo, "Only the note"); err != nil {
		t.Fatal(err)
	}
	if files := strings.Fields(command(t, repo, "show", "--name-only", "--format=", "HEAD")); len(files) != 1 || files[0] != "note.txt" {
		t.Fatalf("the commit holds %v", files)
	}
	if !strings.Contains(command(t, repo, "status", "--porcelain"), "other.txt") {
		t.Fatal("an unstaged file was committed")
	}
	if _, err := git.CommitStaged(ctx, repo, "Nothing staged"); err == nil {
		t.Fatal("an empty commit was made")
	}
	for _, escape := range []string{"../outside.txt", "-A"} {
		if git.Stage(ctx, repo, []string{escape}) == nil || git.Unstage(ctx, repo, []string{escape}) == nil {
			t.Fatalf("%q was accepted", escape)
		}
	}
	write(t, repo, "new.txt", "new\n")
	if err := git.Stage(ctx, repo, []string{"new.txt"}); err != nil {
		t.Fatal(err)
	}
	if err := git.Unstage(ctx, repo, []string{"new.txt"}); err != nil {
		t.Fatalf("unstaging a new file: %v", err)
	}
	if strings.Contains(command(t, repo, "diff", "--cached", "--name-only"), "new.txt") {
		t.Fatal("a new file stayed staged")
	}
}

func TestStagingInARepositoryWithoutACommitWorks(t *testing.T) {
	ctx := context.Background()
	repo := t.TempDir()
	command(t, repo, "init", "-b", "main")
	write(t, repo, "first.txt", "first\n")
	if err := git.Stage(ctx, repo, []string{"first.txt"}); err != nil {
		t.Fatal(err)
	}
	if err := git.Unstage(ctx, repo, []string{"first.txt"}); err != nil {
		t.Fatalf("unstaging before the first commit: %v", err)
	}
	if strings.TrimSpace(command(t, repo, "diff", "--cached", "--name-only")) != "" {
		t.Fatal("still staged")
	}
}

func TestStatusReportsTheRemoteAndHowFarTheBranchIsAhead(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	state, err := git.Status(ctx, repo)
	if err != nil || state.Remote != "" || state.Upstream {
		t.Fatalf("a repository without a remote: %+v err=%v", state, err)
	}
	remote := filepath.Join(t.TempDir(), "remote.git")
	command(t, filepath.Dir(remote), "init", "--bare", "-b", "main", remote)
	command(t, repo, "remote", "add", "origin", remote)
	if state, _ = git.Status(ctx, repo); state.Remote != "origin" || state.Upstream {
		t.Fatalf("a remote without an upstream: %+v", state)
	}
	if err := git.Push(ctx, repo); err != nil {
		t.Fatal(err)
	}
	if state, _ = git.Status(ctx, repo); !state.Upstream || state.Ahead != 0 || state.Behind != 0 {
		t.Fatalf("a pushed branch: %+v", state)
	}
	write(t, repo, "note.txt", "next\n")
	if _, err := git.CommitChanges(ctx, repo, "Next", nil); err != nil {
		t.Fatal(err)
	}
	if state, _ = git.Status(ctx, repo); !state.Upstream || state.Ahead != 1 {
		t.Fatalf("a branch with one new commit: %+v", state)
	}
}

func TestStatusSaysWhichFilesAreStagedAndWhichChangedAgainInTheWorkingTree(t *testing.T) {
	ctx := context.Background()
	repo := repository(t)
	write(t, repo, "note.txt", "staged\n")
	write(t, repo, "new.txt", "new\n")
	if err := git.Stage(ctx, repo, []string{"note.txt"}); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "note.txt", "staged and then changed\n")
	state, err := git.Status(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][2]bool{}
	for _, file := range state.Files {
		got[file.Path] = [2]bool{file.Staged, file.Unstaged}
	}
	if got["note.txt"] != [2]bool{true, true} || got["new.txt"] != [2]bool{false, true} {
		t.Fatalf("files=%v", got)
	}
	if err := git.Stage(ctx, repo, []string{"note.txt"}); err != nil {
		t.Fatal(err)
	}
	state, _ = git.Status(ctx, repo)
	for _, file := range state.Files {
		if file.Path == "note.txt" && (!file.Staged || file.Unstaged) {
			t.Fatalf("a fully staged file still shows a working-tree change: %+v", file)
		}
	}
}
