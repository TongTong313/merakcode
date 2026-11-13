package server_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	codepanel "github.com/TongTong313/merakcode/merak/engine/code"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	body, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, body)
	}
	return strings.TrimSpace(string(body))
}

func TestCodeMethodsCommitFindFilesAndShareOneWorktreePerKey(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := t.TempDir()
	gitIn(t, repo, "init", "-b", "main")
	gitIn(t, repo, "config", "user.name", "Fixture")
	gitIn(t, repo, "config", "user.email", "fixture@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "add", ".")
	gitIn(t, repo, "commit", "-m", "Baseline")
	e, err := engine.New(engine.Deps{Workdir: repo, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var status codepanel.Status
	if err := client.Call(ctx, "file.status", protocol.FileParams{DirectoryParams: protocol.DirectoryParams{Directory: filepath.ToSlash(repo) + "/"}, Path: "README.md"}, &status); err != nil || status.Status != "modified" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	var committed protocol.RepoCommitResult
	if err := client.Call(ctx, "repo.commit", protocol.RepoCommitParams{DirectoryParams: protocol.DirectoryParams{Directory: repo}, Message: "Second"}, &committed); err != nil || committed.Commit != gitIn(t, repo, "rev-parse", "HEAD") {
		t.Fatalf("commit=%+v err=%v", committed, err)
	}
	var found []string
	if err := client.Call(ctx, "file.find", protocol.FileFindParams{DirectoryParams: protocol.DirectoryParams{Directory: repo}, Query: "read"}, &found); err != nil || len(found) != 1 || found[0] != "README.md" {
		t.Fatalf("found=%v err=%v", found, err)
	}

	params := protocol.WorktreeCreateParams{DirectoryParams: protocol.DirectoryParams{Directory: repo}, Key: "first-message"}
	var first, again codepanel.Worktree
	if err := client.Call(ctx, "worktree.create", params, &first); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "worktree.create", params, &again); err != nil || again.Path != first.Path {
		t.Fatalf("first=%+v again=%+v err=%v", first, again, err)
	}
	var listed []codepanel.Worktree
	if err := client.Call(ctx, "worktree.list", protocol.DirectoryParams{Directory: repo}, &listed); err != nil || len(listed) != 1 {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	var failure *protocol.Error
	err = client.Call(ctx, "worktree.merge", protocol.WorktreePathParams{Path: filepath.Join(t.TempDir(), "stranger")}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-6020" {
		t.Fatalf("merging a stranger: %v", err)
	}
	if err := client.Call(ctx, "worktree.remove", protocol.WorktreePathParams{Path: first.Path}, nil); err != nil {
		t.Fatal(err)
	}
	err = client.Call(ctx, "repo.commitMessage", protocol.DirectoryParams{Directory: repo}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-6019" {
		t.Fatalf("a message for no changes: %v", err)
	}
}

func TestFileWriteRPCSavesOverTheVersionTheClientRead(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: dir, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	where := protocol.FileParams{DirectoryParams: protocol.DirectoryParams{Directory: dir}, Path: "note.txt"}
	var read engine.FileContent
	if err := client.Call(ctx, "file.read", where, &read); err != nil || read.Checksum == "" {
		t.Fatalf("read=%+v err=%v", read, err)
	}
	var saved protocol.FileWriteResult
	if err := client.Call(ctx, "file.write", protocol.FileWriteParams{FileParams: where, Content: "two\n", Checksum: read.Checksum}, &saved); err != nil || saved.Checksum == "" {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	var failure *protocol.Error
	err = client.Call(ctx, "file.write", protocol.FileWriteParams{FileParams: where, Content: "three\n", Checksum: read.Checksum}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-4029" {
		t.Fatalf("a stale save: %v", err)
	}
	if err := client.Call(ctx, "file.write", protocol.FileWriteParams{FileParams: where, Content: "three\n", Checksum: read.Checksum, Force: true}, nil); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(filepath.Join(dir, "note.txt")); string(body) != "three\n" {
		t.Fatalf("file=%q", body)
	}
}

func TestStageUnstageAndAStagedCommitOverRPC(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := t.TempDir()
	gitIn(t, repo, "init", "-b", "main")
	gitIn(t, repo, "config", "user.name", "Fixture")
	gitIn(t, repo, "config", "user.email", "fixture@example.invalid")
	for name, body := range map[string]string{"a.txt": "a\n", "b.txt": "b\n"} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gitIn(t, repo, "add", ".")
	gitIn(t, repo, "commit", "-m", "Baseline")
	e, err := engine.New(engine.Deps{Workdir: repo, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte("changed\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	where := protocol.DirectoryParams{Directory: repo}
	if err := client.Call(ctx, "repo.stage", protocol.RepoPathsParams{DirectoryParams: where, Paths: []string{"a.txt", "b.txt"}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "repo.unstage", protocol.RepoPathsParams{DirectoryParams: where, Paths: []string{"b.txt"}}, nil); err != nil {
		t.Fatal(err)
	}
	var committed protocol.RepoCommitResult
	if err := client.Call(ctx, "repo.commit", protocol.RepoCommitParams{DirectoryParams: where, Message: "Staged only", Staged: true}, &committed); err != nil || committed.Commit != gitIn(t, repo, "rev-parse", "HEAD") {
		t.Fatalf("commit=%+v err=%v", committed, err)
	}
	if files := strings.Fields(gitIn(t, repo, "show", "--name-only", "--format=", "HEAD")); len(files) != 1 || files[0] != "a.txt" {
		t.Fatalf("the commit holds %v", files)
	}
}

func TestRepoWatchAnnouncesAnExternalCheckoutUntilTheConnectionCloses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	repo := t.TempDir()
	gitIn(t, repo, "init", "-b", "main")
	gitIn(t, repo, "config", "user.name", "Fixture")
	gitIn(t, repo, "config", "user.email", "fixture@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "add", ".")
	gitIn(t, repo, "commit", "-m", "Baseline")
	gitIn(t, repo, "branch", "one")
	gitIn(t, repo, "branch", "two")
	e, err := engine.New(engine.Deps{Workdir: repo, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e.SetDirectoryWatchInterval(100 * time.Millisecond)
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.RepoChanged}})
	defer stop()
	if err := client.Call(ctx, "repo.watch", protocol.DirectoryParams{Directory: repo}, nil); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "switch", "--quiet", "one")
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("an external checkout was not announced to a client that watches the folder")
	}

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond) // the server lets go of the connection's watches when it notices the close
	for len(facts) > 0 {
		<-facts
	}
	gitIn(t, repo, "switch", "--quiet", "two")
	select {
	case fact := <-facts:
		t.Fatalf("a folder whose watcher closed its connection was announced: %s", fact.Payload)
	case <-time.After(1500 * time.Millisecond):
	}
	if err := client2Missing(ctx, host.URL, repo); err == nil {
		t.Fatal("repo.watch accepted a folder that does not exist")
	}
}

// client2Missing asks a second connection to watch a folder that does not exist.
func client2Missing(ctx context.Context, url, repo string) error {
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(url, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Call(ctx, "repo.watch", protocol.DirectoryParams{Directory: filepath.Join(repo, "missing")}, nil)
}
