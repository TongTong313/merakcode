package watch_test

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/watch"
)

func command(t *testing.T, directory string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = directory
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func repository(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(directory, func(name string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				_ = os.Chmod(name, 0600)
			}
			return nil
		})
	})
	command(t, directory, "init", "-b", "main")
	command(t, directory, "config", "user.name", "Fixture")
	command(t, directory, "config", "user.email", "fixture@example.invalid")
	command(t, directory, "config", "core.autocrlf", "false")
	write(t, directory, "guide.md", "Initial guide\n")
	command(t, directory, "add", ".")
	command(t, directory, "commit", "-m", "Initial fixture")
	return directory
}

func write(t *testing.T, directory, name, body string) {
	t.Helper()
	target := filepath.Join(directory, name)
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRepositoryReportsExternalCommitsAndTheirPathsOnce(t *testing.T) {
	ctx := context.Background()
	directory := repository(t)
	watcher, err := watch.NewRepository(ctx, directory, "main")
	if err != nil {
		t.Fatal(err)
	}
	if change, err := watcher.Poll(ctx); err != nil || change != nil {
		t.Fatalf("idle=%+v, %v", change, err)
	}
	write(t, directory, "guide.md", "Revised guide\n")
	command(t, directory, "add", ".")
	command(t, directory, "commit", "-m", "Revise guide")
	first := command(t, directory, "rev-parse", "HEAD")
	write(t, directory, "docs/example.md", "Example\n")
	command(t, directory, "add", ".")
	command(t, directory, "commit", "-m", "Add example")
	second := command(t, directory, "rev-parse", "HEAD")
	change, err := watcher.Poll(ctx)
	if err != nil || change == nil {
		t.Fatalf("change=%+v, %v", change, err)
	}
	if change.Head != second || change.Branch != "main" || change.Target != second {
		t.Fatalf("references=%+v", change)
	}
	want := []watch.Commit{{ID: first, Paths: []string{"guide.md"}}, {ID: second, Paths: []string{"docs/example.md"}}}
	if !reflect.DeepEqual(change.Commits, want) {
		t.Fatalf("commits=%+v, want %+v", change.Commits, want)
	}
	if next, err := watcher.Poll(ctx); err != nil || next != nil {
		t.Fatalf("duplicate=%+v, %v", next, err)
	}
}

func TestRepositoryTracksCheckoutAndTargetChangesIndependently(t *testing.T) {
	ctx := context.Background()
	directory := repository(t)
	baseline := command(t, directory, "rev-parse", "HEAD")
	watcher, err := watch.NewRepository(ctx, directory, "main")
	if err != nil {
		t.Fatal(err)
	}
	command(t, directory, "checkout", "-b", "topic")
	change, err := watcher.Poll(ctx)
	if err != nil || change == nil || change.Branch != "topic" || change.Head != baseline || change.Target != baseline || len(change.Commits) != 0 {
		t.Fatalf("checkout=%+v, %v", change, err)
	}
	write(t, directory, "guide.md", "Topic revision\n")
	command(t, directory, "add", ".")
	command(t, directory, "commit", "-m", "Topic revision")
	head := command(t, directory, "rev-parse", "HEAD")
	if change, err = watcher.Poll(ctx); err != nil || change == nil || change.Head != head || change.Target != baseline {
		t.Fatalf("topic=%+v, %v", change, err)
	}
	target := command(t, directory, "commit-tree", "HEAD^{tree}", "-p", baseline, "-m", "External target revision")
	command(t, directory, "update-ref", "refs/heads/main", target)
	change, err = watcher.Poll(ctx)
	if err != nil || change == nil || change.Head != head || change.Target != target {
		t.Fatalf("target=%+v, %v", change, err)
	}
	if want := []watch.Commit{{ID: target, Paths: []string{"guide.md"}}}; !reflect.DeepEqual(change.Commits, want) {
		t.Fatalf("target commits=%+v", change.Commits)
	}
}
