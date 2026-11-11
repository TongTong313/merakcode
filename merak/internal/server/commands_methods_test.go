package server_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestCommandsAndFileAgentsAreServedThroughTheProtocolAndConfiguredCommandsAreRead(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	home, project := t.TempDir(), t.TempDir()
	write := func(root, name, body string) {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(home, "merakcode.jsonc", `{"command": {"fix": {"template": "Fix $ARGUMENTS", "description": "Fix a bug", "model": "fake/other"}}}`)
	write(project, ".merakcode/commands/deploy.md", "---\ndescription: Ship it\n---\nDeploy $ARGUMENTS.")
	write(project, ".merakcode/agents/reviewer.md", "---\ndescription: Reviews code\n---\nYou review code.")
	var seen model.Request
	provider := fake.New(t, fake.Reply{Text: "Fixed.", Expect: func(req model.Request) error { seen = req; return nil }})
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	var commands []command.Command
	if err := client.Call(ctx, "command.list", protocol.DirectoryParams{Directory: project}, &commands); err != nil {
		t.Fatal(err)
	}
	by := map[string]command.Command{}
	for _, c := range commands {
		by[c.Name] = c
	}
	if by["fix"].Source != command.Config || by["fix"].Model != "fake/other" || by["deploy"].Source != command.File || by["init"].Source != command.Builtin {
		t.Fatalf("commands=%+v", by)
	}
	var agents []agent.Agent
	if err := client.Call(ctx, "agent.list", protocol.AgentListParams{Directory: project}, &agents); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range agents {
		found = found || a.Name == "reviewer" && a.Source == "file"
	}
	if !found {
		t.Fatalf("the agent of the file is not listed: %+v", agents)
	}

	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: project, Provider: "fake", Model: "base"}, &created); err != nil {
		t.Fatal(err)
	}
	var result command.Result
	if err := client.Call(ctx, "session.command", protocol.SessionCommandParams{Session: created.Session, Name: "fix", Arguments: "the login bug"}, &result); err != nil || !result.Sent {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for seen.Model == "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if seen.Model != "other" || lastUserText(seen) != "Fix the login bug" {
		t.Fatalf("the model saw model=%q text=%q", seen.Model, lastUserText(seen))
	}
	var failure *protocol.Error
	err = client.Call(ctx, "session.command", protocol.SessionCommandParams{Session: created.Session, Name: "nope"}, &result)
	if !errors.As(err, &failure) {
		t.Fatalf("an unknown command: %v", err)
	}
}

func lastUserText(req model.Request) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == model.User {
			parts := req.Messages[i].Parts
			return parts[len(parts)-1].Text
		}
	}
	return ""
}
