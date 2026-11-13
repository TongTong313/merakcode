package engine_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
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
	dir := integrationRepository(t)
	e, err := engine.New(engine.Deps{Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.SetDirectoryWatchInterval(100 * time.Millisecond)
	fixtureGit(t, dir, "branch", "feature")
	events, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.RepoChanged, engine.FileChanged}})
	defer stop()
	if err := e.WatchDirectory(context.Background(), "client-1", dir); err != nil {
		t.Fatal(err)
	}

	fixtureGit(t, dir, "switch", "--quiet", "feature")
	var repo engine.RepoChanges
	if err := json.Unmarshal(next(t, events, engine.RepoChanged).Payload, &repo); err != nil {
		t.Fatal(err)
	}
	if repo.Branch != "feature" || repo.Directory != dir {
		t.Fatalf("repo.changed = %+v, want the branch feature of %s", repo, dir)
	}

	if err := os.WriteFile(filepath.Join(dir, "made-outside.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var files engine.FileChanges
	if err := json.Unmarshal(next(t, events, engine.FileChanged).Payload, &files); err != nil {
		t.Fatal(err)
	}
	if len(files.Paths) != 1 || files.Paths[0] != "made-outside.txt" {
		t.Fatalf("file.changed = %+v", files)
	}
}

func TestWatchingAFolderTwiceDoesNotAnnounceEverythingTwiceAndLettingGoOfItStopsTheAnnouncements(t *testing.T) {
	dir := integrationRepository(t)
	e, err := engine.New(engine.Deps{Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.SetDirectoryWatchInterval(100 * time.Millisecond)
	fixtureGit(t, dir, "branch", "one")
	fixtureGit(t, dir, "branch", "two")
	events, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.RepoChanged}})
	defer stop()
	for _, owner := range []string{"a", "b"} {
		if err := e.WatchDirectory(context.Background(), owner, dir); err != nil {
			t.Fatal(err)
		}
	}
	fixtureGit(t, dir, "switch", "--quiet", "one")
	next(t, events, engine.RepoChanged)
	select {
	case fact := <-events:
		t.Fatalf("two watchers made a second announcement of one change: %s", fact.Payload)
	case <-time.After(600 * time.Millisecond):
	}

	e.UnwatchDirectories("a")
	fixtureGit(t, dir, "switch", "--quiet", "two")
	next(t, events, engine.RepoChanged) // owner b still watches
	e.UnwatchDirectories("b")
	time.Sleep(300 * time.Millisecond) // let a poll that was already running finish
	for len(events) > 0 {
		<-events
	}
	fixtureGit(t, dir, "switch", "--quiet", "one")
	select {
	case fact := <-events:
		t.Fatalf("a folder nobody watches was announced: %s", fact.Payload)
	case <-time.After(800 * time.Millisecond):
	}
}

func TestWatchingAFolderThatDoesNotExistIsRefused(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if err := e.WatchDirectory(context.Background(), "client", filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("a folder that does not exist was accepted")
	}
}
