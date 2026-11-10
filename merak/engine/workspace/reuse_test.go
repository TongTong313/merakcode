package workspace_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func TestReleasedWorktreeResetsForNextClaimAndKeepsIgnoredDependencies(t *testing.T) {
	ctx := t.Context()
	repo := repository(t)
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("node_modules/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command(t, repo, "add", ".gitignore")
	command(t, repo, "commit", "-m", "Ignore dependencies")
	base := command(t, repo, "rev-parse", "HEAD")
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	m := workspace.New(ctx, storage, bus, event.NewID)
	defer m.Close()
	first, err := m.ForClaim(ctx, repo, task.Claim{ID: "first-claim", Task: "first", Member: "worker"}, task.Card{ID: "first", Group: "group", Workspace: workspace.KindWorktree, Base: base})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(first.Directory, "node_modules"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"node_modules/cache": "retained", "README.md": "first result", "temporary.txt": "discard"} {
		if err := os.WriteFile(filepath.Join(first.Directory, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	command(t, first.Directory, "add", "README.md")
	command(t, first.Directory, "commit", "-m", "First result")
	previous := command(t, first.Directory, "rev-parse", "HEAD")
	if err := os.Mkdir(filepath.Join(first.Directory, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	command(t, filepath.Join(first.Directory, "nested"), "init")
	if err := m.Release(ctx, first); err != nil {
		t.Fatal(err)
	}
	m.Close()
	m = workspace.New(ctx, storage, bus, event.NewID)
	defer m.Close()
	second, err := m.ForClaim(ctx, repo, task.Claim{ID: "second-claim", Task: "second", Member: "worker"}, task.Card{ID: "second", Group: "group", Workspace: workspace.KindWorktree, Base: base})
	if err != nil {
		t.Fatal(err)
	}
	if first.Directory != second.Directory || first.ID == second.ID || first.Branch == second.Branch {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
	body, err := os.ReadFile(filepath.Join(second.Directory, "node_modules/cache"))
	if err != nil || string(body) != "retained" {
		t.Fatalf("cache=%q %v", body, err)
	}
	if _, err := os.Stat(filepath.Join(second.Directory, "temporary.txt")); !os.IsNotExist(err) {
		t.Fatalf("temporary file remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(second.Directory, "nested")); !os.IsNotExist(err) {
		t.Fatalf("nested repository remains: %v", err)
	}
	if head := command(t, second.Directory, "rev-parse", "HEAD"); head != base {
		t.Fatalf("head=%s base=%s", head, base)
	}
	if head := command(t, repo, "rev-parse", first.Branch); head != previous {
		t.Fatal("reuse changed the previous result branch")
	}
}

func TestInvalidReuseBaseKeepsTheDirectoryAvailable(t *testing.T) {
	ctx := t.Context()
	repo := repository(t)
	base := command(t, repo, "rev-parse", "HEAD")
	storage := memory.New()
	m := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
	defer m.Close()
	first, err := m.ForClaim(ctx, repo, task.Claim{ID: "first-claim", Task: "first", Member: "worker"}, task.Card{ID: "first", Group: "group", Workspace: workspace.KindWorktree, Base: base})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Release(ctx, first); err != nil {
		t.Fatal(err)
	}
	claim := task.Claim{ID: "second-claim", Task: "second", Member: "worker"}
	card := task.Card{ID: "second", Group: "group", Workspace: workspace.KindWorktree, Base: "missing-base"}
	if _, err := m.ForClaim(ctx, repo, claim, card); err == nil {
		t.Fatal("invalid base accepted")
	}
	card.Base = base
	second, err := m.ForClaim(ctx, repo, claim, card)
	if err != nil {
		t.Fatal(err)
	}
	if second.Directory != first.Directory {
		t.Fatal("failed reuse abandoned its directory")
	}
}

func TestWorktreePoolKeepsOnlyTwoReleasedDirectories(t *testing.T) {
	ctx := t.Context()
	repo := repository(t)
	base := command(t, repo, "rev-parse", "HEAD")
	storage := memory.New()
	m := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
	defer m.Close()
	var all []workspace.Workspace
	for i := range 3 {
		id := event.ID(fmt.Sprint("task-", i))
		ws, err := m.ForClaim(ctx, repo, task.Claim{ID: id, Task: id, Member: "worker"}, task.Card{ID: id, Group: "group", Workspace: workspace.KindWorktree, Base: base})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(ws.Directory, "temporary.txt"), []byte("discard after release"), 0600); err != nil {
			t.Fatal(err)
		}
		all = append(all, ws)
	}
	for _, ws := range all {
		if err := m.Release(ctx, ws); err != nil {
			t.Fatal(err)
		}
	}
	kept := 0
	for _, ws := range all {
		if _, err := os.Stat(ws.Directory); err == nil {
			kept++
		}
	}
	if kept != 2 {
		t.Fatalf("kept=%d", kept)
	}
}
