package engine_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func lastUserText(req model.Request) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role != model.User {
			continue
		}
		parts := req.Messages[i].Parts
		return parts[len(parts)-1].Text
	}
	return ""
}

func TestCommandsListEveryKindAndRunningOneSendsItsExpandedTemplate(t *testing.T) {
	binary := buildPromptServer(t)
	root, project := t.TempDir(), t.TempDir()
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settings.Update(config.Patch{MCP: map[string]*config.MCPServer{"docs": {Command: binary}}}); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		".merakcode/commands/deploy.md":  "---\ndescription: Ship it\n---\nDeploy $ARGUMENTS to production.",
		".merakcode/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDF files\n---\nPDF body.",
	} {
		path := filepath.Join(project, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var got []string
	record := func(req model.Request) error { got = append(got, lastUserText(req)); return nil }
	provider := fake.New(t,
		fake.Reply{Text: "ok", Expect: record},
		fake.Reply{Text: "ok", Expect: record},
		fake.Reply{Text: "ok", Expect: record},
		fake.Reply{Text: "ok", Expect: record},
	)
	e, err := engine.New(engine.Deps{Workdir: project, NetworkSettings: settings, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureCommands(map[string]command.Entry{"fix": {Template: "Fix $ARGUMENTS", Description: "Fix a bug"}})

	list, err := e.CommandList(t.Context(), project)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]command.Command{}
	for _, c := range list {
		by[c.Name] = c
	}
	for name, source := range map[string]command.Source{"init": command.Builtin, "review": command.Builtin, "context": command.Builtin, "fix": command.Config, "deploy": command.File, "pdf": command.SkillSource, "docs:explain": command.MCP} {
		if by[name].Source != source {
			t.Errorf("%s: source %q, want %q", name, by[name].Source, source)
		}
	}

	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeAsk})
	if err != nil {
		t.Fatal(err)
	}
	r := &chatRig{t: t, e: e, ctx: t.Context(), dir: project, id: id}
	run := func(name, arguments string) command.Result {
		t.Helper()
		turns, stop := e.Bus.Subscribe(turnFilter(id))
		defer stop()
		result, err := e.RunCommand(t.Context(), id, name, arguments)
		if err != nil {
			t.Fatalf("/%s: %v", name, err)
		}
		if result.Sent {
			<-turns
		}
		return result
	}
	if result := run("fix", "the login bug"); !result.Sent || got[len(got)-1] != "Fix the login bug" {
		t.Fatalf("/fix: %+v got=%q", result, got)
	}
	run("deploy", "v2")
	if got[len(got)-1] != "Deploy v2 to production." {
		t.Fatalf("/deploy sent %q", got[len(got)-1])
	}
	run("docs:explain", "closures")
	if got[len(got)-1] != "Please explain closures in simple words." {
		t.Fatalf("an MCP prompt sent %q", got[len(got)-1])
	}
	run("pdf", "pull the tables out")
	if !strings.Contains(got[len(got)-1], "skill pdf") || !strings.Contains(got[len(got)-1], "pull the tables out") {
		t.Fatalf("a skill command sent %q", got[len(got)-1])
	}
	before := len(got)
	report := run("context", "")
	if report.Sent || len(got) != before || !strings.Contains(report.Text, "System prompt") || !strings.Contains(report.Text, "Tools") || !strings.Contains(report.Text, "Messages") {
		t.Fatalf("/context: %+v", report)
	}
	if _, err := e.RunCommand(t.Context(), id, "nope", ""); err == nil {
		t.Fatal("an unknown command ran")
	}
	_ = r
}

func TestInitWritesAnAgentsFileInAProjectThatHasNone(t *testing.T) {
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("# Demo\nRun make test.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t,
		integrationCall("write_file", map[string]any{"path": "AGENTS.md", "content": "# Demo\n\nRun `make test` before you commit.\n"}),
		fake.Reply{Text: "Created AGENTS.md.", Expect: func(req model.Request) error {
			if !strings.Contains(fmt.Sprint(req.Messages), "AGENTS.md") {
				return fmt.Errorf("the model was not asked about AGENTS.md")
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Bus.Subscribe(turnFilter(id))
	defer stop()
	if _, err := e.RunCommand(t.Context(), id, "init", ""); err != nil {
		t.Fatal(err)
	}
	<-turns
	body, err := os.ReadFile(filepath.Join(project, "AGENTS.md"))
	if err != nil || !strings.Contains(string(body), "make test") {
		t.Fatalf("AGENTS.md=%q err=%v", body, err)
	}
}
