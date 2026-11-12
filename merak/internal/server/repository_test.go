package server_test

import (
	"context"
	"io/fs"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestRepositoryRPCUsesSessionBaselineAndReadsWorkspace(t *testing.T) {
	dir := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				_ = os.Chmod(path, 0600)
			}
			return nil
		})
	})
	command := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		body, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s %v", args, body, err)
		}
		return strings.TrimSpace(string(body))
	}
	command("init", "-b", "main")
	command("config", "core.autocrlf", "false")
	command("config", "user.name", "Fixture")
	command("config", "user.email", "fixture@example.invalid")
	file := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(file, []byte("baseline\n"), 0600); err != nil {
		t.Fatal(err)
	}
	command("add", ".")
	command("commit", "-m", "Baseline fixture")
	baseline := command("rev-parse", "HEAD")
	command("branch", "feature")
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: []byte(`{"path":"note.txt","content":"changed\n"}`)}}},
		fake.Reply{Text: "Done."},
	)}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", map[string]any{"provider": "fake", "workdir": dir, "mode": "takeover"}, &created); err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err := client.Call(ctx, "session.snapshot", protocol.SessionCancelParams{Session: created.Session}, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["baseCommit"] != baseline {
		t.Fatalf("baseCommit=%v", snapshot["baseCommit"])
	}
	// The agent changes the file in a turn; the person commits it afterwards, which is no reason to stop reviewing it
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "change the note"}}}, nil); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(10 * time.Second); command("status", "--porcelain") == ""; {
		if time.Now().After(deadline) {
			t.Fatal("the agent did not change the file")
		}
		time.Sleep(20 * time.Millisecond)
	}
	command("commit", "-am", "Later fixture commit")
	var diff []git.Change
	if err := client.Call(ctx, "repo.diff", map[string]any{"directory": dir, "session": created.Session}, &diff); err != nil {
		t.Fatal(err)
	}
	if len(diff) != 1 || diff[0].Before != "baseline\n" || diff[0].After != "changed\n" {
		t.Fatalf("diff=%+v", diff)
	}
	var status map[string]any
	decision := map[string]any{"session": created.Session, "files": []any{map[string]any{"file": "note.txt", "version": diff[0].Version}}}
	if err := client.Call(ctx, "review.accept", decision, &status); err != nil {
		t.Fatal(err)
	}
	if last, _ := status["last"].(map[string]any); last["decision"] != "accept" {
		t.Fatalf("status after accepting=%v", status)
	}
	if err := client.Call(ctx, "repo.diff", map[string]any{"directory": dir, "session": created.Session}, &diff); err != nil || len(diff) != 0 {
		t.Fatalf("diff after accepting=%+v err=%v", diff, err)
	}
	status = nil
	if err := client.Call(ctx, "review.undo", protocol.SessionCancelParams{Session: created.Session}, &status); err != nil || status["last"] != nil {
		t.Fatalf("undo: status=%v err=%v", status, err)
	}
	if err := client.Call(ctx, "repo.diff", map[string]any{"directory": dir, "session": created.Session}, &diff); err != nil || len(diff) != 1 {
		t.Fatalf("diff after undo=%+v err=%v", diff, err)
	}
	if err := client.Call(ctx, "review.reject", decision, &status); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(file); string(got) != "baseline\n" {
		t.Fatalf("file after rejecting: %q", got)
	}
	if err := client.Call(ctx, "review.undo", protocol.SessionCancelParams{Session: created.Session}, &status); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(file); string(got) != "changed\n" {
		t.Fatalf("file after undoing the rejection: %q", got)
	}
	for _, test := range []struct {
		method string
		params any
	}{
		{"repo.status", map[string]any{"directory": dir}},
		{"repo.branches", map[string]any{"directory": dir}},
		{"repo.checkout", map[string]any{"directory": dir, "branch": "feature"}},
		{"file.read", map[string]any{"directory": dir, "path": "note.txt"}},
		{"file.list", map[string]any{"directory": dir, "path": "."}},
	} {
		t.Run(test.method, func(t *testing.T) {
			var result any
			if err := client.Call(ctx, test.method, test.params, &result); err != nil {
				t.Fatal(err)
			}
			switch test.method {
			case "repo.status":
				if result.(map[string]any)["branch"] != "main" {
					t.Fatalf("status=%v", result)
				}
			case "repo.branches":
				if len(result.([]any)) != 2 {
					t.Fatalf("branches=%v", result)
				}
			case "repo.checkout":
				if command("branch", "--show-current") != "feature" {
					t.Fatal("branch did not change")
				}
			case "file.read":
				if result.(map[string]any)["content"] != "baseline\n" {
					t.Fatalf("file=%v", result)
				}
			case "file.list":
				if len(result.([]any)) != 1 {
					t.Fatalf("entries=%v", result)
				}
			}
		})
	}
}
