package git_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestClaimContextPreservesRepositoryEnvironmentIsolation(t *testing.T) {
	directory, other := repository(t), repository(t)
	command(t, other, "commit", "--allow-empty", "-m", "Other repository")
	expected := strings.TrimSpace(command(t, directory, "rev-parse", "HEAD"))
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", other)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(other, ".git", "index"))
	state, err := git.Status(process.WithReflogAction(context.Background(), "merak-claim[claim]"), directory)
	if err != nil || state.Head != expected {
		t.Fatalf("redirected repository: %+v, %v", state, err)
	}
}

func TestClaimCommitAttributionDoesNotClaimExistingHistoryAfterAReset(t *testing.T) {
	dir := repository(t)
	ctx := context.Background()
	external := strings.TrimSpace(command(t, dir, "rev-parse", "HEAD"))
	marked := func(args ...string) {
		t.Helper()
		cmd := process.Command(process.WithReflogAction(ctx, "merak-claim[claim]"), dir, "git", args...)
		if body, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("marked command: %s, %v", body, err)
		}
	}
	marked("commit", "--allow-empty", "-m", "Member commit")
	own := strings.TrimSpace(command(t, dir, "rev-parse", "HEAD"))
	marked("reset", "--soft", external)
	command(t, dir, "reset", "--soft", own)
	owners, err := git.ClaimCommits(ctx, dir)
	if err != nil || owners[external] != "" || owners[own] != "claim" {
		t.Fatalf("owners=%v, %v", owners, err)
	}
}

func TestResetWithExpiredHistoryDoesNotAcquireCommitOwnership(t *testing.T) {
	directory := repository(t)
	old := strings.TrimSpace(command(t, directory, "rev-parse", "HEAD"))
	command(t, directory, "commit", "--allow-empty", "-m", "Later external commit")
	command(t, directory, "reflog", "expire", "--expire=all", "--all")
	ctx := process.WithReflogAction(context.Background(), "merak-claim[claim]")
	cmd := process.Command(ctx, directory, "git", "reset", "--soft", old)
	if body, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("reset: %s, %v", body, err)
	}
	owners, err := git.ClaimCommits(context.Background(), directory)
	if err != nil || owners[old] != "" {
		t.Fatalf("reset acquired existing commit: %v, %v", owners, err)
	}
}
