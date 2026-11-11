package command_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/skill"
)

func put(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCommandsComeFromTheBinaryTheConfigurationFilesSkillsAndMCPServers(t *testing.T) {
	project, global := t.TempDir(), t.TempDir()
	put(t, project, ".merakcode/commands/deploy.md", "---\ndescription: Ship it\nagent: build\nmodel: fake/big\n---\nDeploy $ARGUMENTS to production.")
	put(t, project, ".merakcode/command/team/standup.md", "Write a standup for $ARGUMENTS")
	put(t, global, "commands/notes.md", "---\ndescription: Notes\n---\nTake notes on $ARGUMENTS")
	put(t, global, "commands/deploy.md", "Global deploy $ARGUMENTS")
	put(t, project, ".merakcode/skills/lint/SKILL.md", "---\nname: lint\ndescription: Run linters\n---\nRun them.")
	skills, err := skill.Discover(project, "")
	if err != nil {
		t.Fatal(err)
	}
	configured := map[string]command.Entry{"fix": {Template: "Fix $ARGUMENTS", Description: "Fix a bug"}}
	prompts := []command.MCPPrompt{{Server: "docs", Name: "explain", Description: "Explain a topic", Arguments: []string{"topic"}}}

	list, err := command.List(project, global, configured, skills, prompts)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]command.Command{}
	for _, c := range list {
		by[c.Name] = c
	}
	for name, source := range map[string]command.Source{
		"init": command.Builtin, "review": command.Builtin, "context": command.Builtin,
		"fix": command.Config, "deploy": command.File, "team/standup": command.File, "notes": command.File,
		"lint": command.SkillSource, "docs:explain": command.MCP,
	} {
		if by[name].Source != source {
			t.Errorf("command %q has source %q, want %q (have %v)", name, by[name].Source, source, names(list))
		}
	}
	if by["deploy"].Description != "Ship it" || by["deploy"].Agent != "build" || by["deploy"].Model != "fake/big" {
		t.Errorf("deploy=%+v", by["deploy"])
	}
	if !strings.HasPrefix(by["deploy"].Template, "Deploy $ARGUMENTS") {
		t.Errorf("a project command must win over a global one: %q", by["deploy"].Template)
	}
	if !slices.IsSortedFunc(list, func(a, b command.Command) int { return strings.Compare(a.Name, b.Name) }) {
		t.Errorf("the list is not sorted: %v", names(list))
	}
}

func TestACommandExpandsItsArgumentsAndTheBuiltInOnesHaveRealTemplates(t *testing.T) {
	c := command.Command{Name: "fix", Template: "Fix $ARGUMENTS now. Again: $ARGUMENTS"}
	if got := c.Expand("the login bug"); got != "Fix the login bug now. Again: the login bug" {
		t.Fatalf("expanded=%q", got)
	}
	if got := (command.Command{Template: "No placeholder"}).Expand("extra words"); got != "No placeholder\n\nextra words" {
		t.Fatalf("a template without a placeholder keeps the arguments after it: %q", got)
	}
	if got := (command.Command{Template: "Only $ARGUMENTS"}).Expand(""); got != "Only" {
		t.Fatalf("empty arguments: %q", got)
	}
	list, err := command.List(t.TempDir(), "", nil, skill.Set{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range list {
		switch c.Name {
		case "init":
			if !strings.Contains(c.Template, "AGENTS.md") || len(strings.Fields(c.Template)) < 40 {
				t.Errorf("/init template: %q", c.Template)
			}
		case "review":
			if !strings.Contains(c.Template, "git diff") {
				t.Errorf("/review template: %q", c.Template)
			}
		case "context":
			if !c.Local {
				t.Error("/context is answered by the engine, not by the model")
			}
		}
	}
}

func names(list []command.Command) []string {
	var all []string
	for _, c := range list {
		all = append(all, c.Name)
	}
	return all
}
