package feature_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/coordinator"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// next returns the next event of a type, or fails when none comes in time.
func next(t *testing.T, events <-chan event.Event, kind event.Type) event.Event {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case fact := <-events:
			if fact.Type == kind {
				return fact
			}
		case <-deadline:
			t.Fatalf("no %s event came", kind)
		}
	}
}

func TestAFolderWithoutAGroupIsWatchedForCheckoutsCommitsAndFileChangesWhileSomeoneWatchesIt(t *testing.T) {
	dir := enginetest.IntegrationRepository(t)
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.SetDirectoryWatchInterval(100 * time.Millisecond)
	enginetest.FixtureGit(t, dir, "branch", "feature")
	events, stop := e.Subscribe(event.Filter{Types: []event.Type{coordinator.RepoChanged, coordinator.FileChanged}})
	defer stop()
	if err := e.WatchDirectory(context.Background(), "client-1", dir); err != nil {
		t.Fatal(err)
	}

	enginetest.FixtureGit(t, dir, "switch", "--quiet", "feature")
	var repo coordinator.RepoChanges
	if err := json.Unmarshal(next(t, events, coordinator.RepoChanged).Payload, &repo); err != nil {
		t.Fatal(err)
	}
	if repo.Branch != "feature" || repo.Directory != dir {
		t.Fatalf("repo.changed = %+v, want the branch feature of %s", repo, dir)
	}

	if err := os.WriteFile(filepath.Join(dir, "made-outside.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var files coordinator.FileChanges
	if err := json.Unmarshal(next(t, events, coordinator.FileChanged).Payload, &files); err != nil {
		t.Fatal(err)
	}
	if len(files.Paths) != 1 || files.Paths[0] != "made-outside.txt" {
		t.Fatalf("file.changed = %+v", files)
	}
}

func TestWatchingAFolderTwiceDoesNotAnnounceEverythingTwiceAndLettingGoOfItStopsTheAnnouncements(t *testing.T) {
	dir := enginetest.IntegrationRepository(t)
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.SetDirectoryWatchInterval(100 * time.Millisecond)
	enginetest.FixtureGit(t, dir, "branch", "one")
	enginetest.FixtureGit(t, dir, "branch", "two")
	events, stop := e.Subscribe(event.Filter{Types: []event.Type{coordinator.RepoChanged}})
	defer stop()
	for _, owner := range []string{"a", "b"} {
		if err := e.WatchDirectory(context.Background(), owner, dir); err != nil {
			t.Fatal(err)
		}
	}
	enginetest.FixtureGit(t, dir, "switch", "--quiet", "one")
	next(t, events, coordinator.RepoChanged)
	select {
	case fact := <-events:
		t.Fatalf("two watchers made a second announcement of one change: %s", fact.Payload)
	case <-time.After(600 * time.Millisecond):
	}

	e.UnwatchDirectories("a")
	enginetest.FixtureGit(t, dir, "switch", "--quiet", "two")
	next(t, events, coordinator.RepoChanged) // owner b still watches
	e.UnwatchDirectories("b")
	time.Sleep(300 * time.Millisecond) // let a poll that was already running finish
	for len(events) > 0 {
		<-events
	}
	enginetest.FixtureGit(t, dir, "switch", "--quiet", "one")
	select {
	case fact := <-events:
		t.Fatalf("a folder nobody watches was announced: %s", fact.Payload)
	case <-time.After(800 * time.Millisecond):
	}
}

func TestWatchingAFolderThatDoesNotExistIsRefused(t *testing.T) {
	deps3 := enginetest.Deps(t)
	deps3.Workdir = t.TempDir()
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.WatchDirectory(context.Background(), "client", filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("a folder that does not exist was accepted")
	}
}
