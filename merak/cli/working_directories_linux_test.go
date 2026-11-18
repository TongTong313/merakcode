package cli

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/feature/admin/skill"
	"github.com/TongTong313/merakcode/merak/engine/feature/code"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
)

// Linux exposes the sandbox's actual private directory through a real sandboxed command.
func TestServeKeepsItsFourWorkingDirectories(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home, project := filepath.Join(root, "home"), filepath.Join(root, "project")
	for _, directory := range []string{home, filepath.Join(project, "skills", "fixture")} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("MERAKCODE_HOME", home)
	if err := os.WriteFile(filepath.Join(project, "skills", "fixture", "SKILL.md"), []byte("---\nname: fixture\ndescription: A directory fixture\n---\nFixture instructions.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git := func(directory string, args ...string) string {
		t.Helper()
		command := exec.CommandContext(ctx, "git", args...)
		command.Dir = directory
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	git(project, "init", "-b", "main")
	git(project, "config", "user.name", "Fixture")
	git(project, "config", "user.email", "fixture@example.invalid")
	git(project, "config", "commit.gpgsign", "false")
	git(project, "add", ".")
	git(project, "commit", "-m", "Add fixture skill")
	replies := []fake.Reply{
		{Calls: []model.ToolCall{{ID: "directory", Name: "bash", Input: json.RawMessage(`{"command":"printf '%s' \"$TMPDIR\" > sandbox-directory.txt"}`)}}},
		{Text: "Recorded the sandbox directory."},
	}
	body, err := json.Marshal(replies)
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "replies.json")
	if err := os.WriteFile(script, body, 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.CommandContext(ctx, executable, "serve", "--script", script)
	child.Dir = project
	prepareBackground(child)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = child.Wait(); close(exited) }()
	t.Cleanup(func() { _ = child.Process.Kill(); <-exited })
	var client *protocol.Client
	for client == nil {
		info, err := server.ReadInfo(filepath.Join(home, "data"))
		if err == nil {
			client, err = protocol.Connect(ctx, info.Endpoint, info.Token, protocol.HelloParams{Protocol: protocol.Version, Capabilities: protocol.Capabilities{Approve: true}})
			if err != nil {
				t.Fatal(err)
			}
			break
		}
		select {
		case <-exited:
			t.Fatal("serve exited before publishing its endpoint")
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Cleanup(func() { _ = client.Close() })
	call := func(method string, params, result any) {
		t.Helper()
		if err := client.Call(ctx, method, params, result); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
	}
	var created protocol.SessionCreateResult
	call("session.create", protocol.SessionCreateParams{Provider: "fake", Workdir: project, Mode: permission.ModeAsk}, &created)
	call("events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, nil)
	call("session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Record the sandbox directory."}}}, nil)
	finished := false
	for !finished {
		select {
		case fact, ok := <-client.Events:
			if !ok {
				t.Fatal("the event connection closed before the turn finished")
			}
			switch fact.Type {
			case permission.Requested:
				call("permission.reply", wire.PermissionReplyParams{Request: fact.ID, Decision: permission.Allow}, nil)
			case loop.TurnFinished:
				outcome, err := event.Decode[loop.Outcome](fact)
				if err != nil || outcome.Stop != loop.Answered {
					t.Fatalf("turn outcome = %+v, %v", outcome, err)
				}
				finished = true
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	// These paths describe the existing layout, independently of startup directory helpers.
	snapshots := filepath.Join(home, "data", "snapshots", string(created.Session))
	sandboxDirectory, err := os.ReadFile(filepath.Join(project, "sandbox-directory.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if got := git(project, "--git-dir", snapshots, "show", ":sandbox-directory.txt"); got != string(sandboxDirectory) {
		t.Fatalf("the session snapshot recorded %q, want %q", got, sandboxDirectory)
	}
	if got, want := filepath.Dir(string(sandboxDirectory)), filepath.Join(home, "data", "sandbox"); got != want {
		t.Fatalf("sandbox state directory = %q, want %q", got, want)
	}
	var worktree code.Worktree
	call("worktree.create", protocol.WorktreeCreateParams{DirectoryParams: protocol.DirectoryParams{Directory: project}, Key: "directory-fixture"}, &worktree)
	if got, want := filepath.Dir(worktree.Path), filepath.Join(home, "data", "worktrees"); got != want {
		t.Fatalf("worktree parent = %q, want %q", got, want)
	}
	if got := git(worktree.Path, "rev-parse", "--show-toplevel"); got != worktree.Path {
		t.Fatalf("actual worktree = %q, want %q", got, worktree.Path)
	}
	cache := filepath.Join(home, "cache", "skills")
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("the skill cache exists before discovery: %v", err)
	}
	var offers []skill.Offer
	call("skill.discover", protocol.SkillDiscoverParams{Source: "file://" + filepath.ToSlash(project)}, &offers)
	if len(offers) != 1 || offers[0].Name != "fixture" {
		t.Fatalf("discovered skills = %+v", offers)
	}
	if info, err := os.Stat(cache); err != nil || !info.IsDir() {
		t.Fatalf("skill cache %q is not a directory: %v", cache, err)
	}
}
