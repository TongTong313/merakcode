package server_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/rules"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestRulesAreReadAndChangedThroughTheProtocolAndPersonalRulesReachTheNextConversation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	home, project := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "AGENTS.md"), []byte("Project instructions"), 0o600); err != nil {
		t.Fatal(err)
	}
	var system string
	provider := fake.New(t, fake.Reply{Text: "Seen.", Expect: func(req model.Request) error { system = req.System; return nil }})
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

	personal := []string{"Reply in short sentences.", "Never use emoji."}
	if err := client.Call(ctx, "rules.change", protocol.RulesChangeParams{Directory: project, Personal: &personal}, nil); err != nil {
		t.Fatal(err)
	}
	body := "---\ndescription: Style\nalwaysApply: true\n---\nUse tabs."
	if err := client.Call(ctx, "rules.change", protocol.RulesChangeParams{Directory: project, File: &protocol.RuleFileChange{Name: "style", Body: &body}}, nil); err != nil {
		t.Fatal(err)
	}
	var read protocol.RulesReadResult
	if err := client.Call(ctx, "rules.read", protocol.DirectoryParams{Directory: project}, &read); err != nil {
		t.Fatal(err)
	}
	if len(read.Personal) != 2 || read.Personal[1] != "Never use emoji." || read.Instructions != "Project instructions" || len(read.Rules) != 1 || read.Rules[0].Name != "style" || read.Rules[0].Kind != rules.Always {
		t.Fatalf("read=%+v", read)
	}
	saved, err := os.ReadFile(filepath.Join(home, "merakcode.jsonc"))
	if err != nil || !strings.Contains(string(saved), "Never use emoji.") || strings.Contains(string(saved), "Use tabs") {
		t.Fatalf("personal rules belong in the global configuration and project rules in the project: %s %v", saved, err)
	}

	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: project, Provider: "fake", Mode: permission.ModeAsk}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Hello"}}}, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for system == "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	for _, want := range []string{"Reply in short sentences.", "Project instructions", "Use tabs."} {
		if !strings.Contains(system, want) {
			t.Fatalf("the prompt lacks %q:\n%s", want, system)
		}
	}
	if strings.Index(system, "Reply in short sentences.") > strings.Index(system, "Project instructions") {
		t.Fatal("personal rules must come before the project's")
	}

	none := []string{}
	if err := client.Call(ctx, "rules.change", protocol.RulesChangeParams{Directory: project, Personal: &none, File: &protocol.RuleFileChange{Name: "style"}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "rules.read", protocol.DirectoryParams{Directory: project}, &read); err != nil || len(read.Personal) != 0 || len(read.Rules) != 0 {
		t.Fatalf("after the deletes: %+v %v", read, err)
	}
	var failure *protocol.Error
	err = client.Call(ctx, "rules.change", protocol.RulesChangeParams{Directory: project, File: &protocol.RuleFileChange{Name: "../escape", Body: &body}}, nil)
	if !errors.As(err, &failure) {
		t.Fatalf("a rule file outside the rules folder was written: %v", err)
	}
}
