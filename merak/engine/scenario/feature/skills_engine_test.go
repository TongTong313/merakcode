package feature_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/storage/vault"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAProjectSkillIsListedInThePromptAndLoadedThroughTheSkillTool(t *testing.T) {
	project := t.TempDir()
	skillDir := filepath.Join(project, ".merakcode", "skills", "deploy")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"SKILL.md":       "---\nname: deploy\ndescription: Ship the app to production\n---\nRun scripts/run.sh and check the logs.",
		"scripts/run.sh": "echo deploy",
	} {
		if err := os.WriteFile(filepath.Join(skillDir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	provider := fake.New(t,
		enginetest.IntegrationCall("skill", map[string]any{"name": "deploy"}),
		fake.Reply{Text: "Loaded.", Expect: func(req model.Request) error {
			var text strings.Builder
			for _, message := range req.Messages {
				for _, part := range message.Parts {
					if part.ToolResult != nil {
						for _, inner := range part.ToolResult.Parts {
							text.WriteString(inner.Text)
						}
					}
				}
			}
			if !strings.Contains(text.String(), "Run scripts/run.sh and check the logs.") || !strings.Contains(text.String(), filepath.Join(skillDir, "scripts", "run.sh")) {
				return fmt.Errorf("the skill tool returned %q", text.String())
			}
			return nil
		}},
	)
	deps := enginetest.Deps(t)
	deps.Workdir = project
	deps.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), conversation.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeAsk})
	if err != nil {
		t.Fatal(err)
	}
	state, err := e.SessionSnapshot(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(state.System, "- deploy: Ship the app to production") || !strings.Contains(state.System, "- docx:") || strings.Contains(state.System, "Run scripts/run.sh") {
		t.Fatalf("the prompt lists the skills wrongly:\n%s", state.System)
	}
	names := map[string]bool{}
	for _, spec := range state.Tools {
		names[spec.Name] = true
	}
	if !names["skill"] {
		t.Fatalf("the skill tool is not offered: %v", names)
	}
	r := &enginetest.ChatRig{T: t, Engine: e, Context: t.Context(), Directory: project, ID: id}
	r.Say("Deploy it")
}

func TestGitSkillsCanBeManagedThroughTheEngine(t *testing.T) {
	for _, test := range []struct {
		name    string
		dataDir bool
	}{
		{"with a data directory", true},
		{"without a data directory", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			repo, project, temporary := filepath.Join(root, "repo"), filepath.Join(root, "project"), filepath.Join(root, "temp")
			for _, directory := range []string{repo, project, temporary} {
				if err := os.MkdirAll(directory, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"TMP", "TEMP", "TMPDIR"} {
				t.Setenv(name, temporary)
			}
			for name, body := range map[string]string{
				"skills/first/SKILL.md":  "---\nname: first\ndescription: First skill\n---\nFirst instructions.",
				"skills/first/data.txt":  "Fixture data.",
				"nested/second/SKILL.md": "---\nname: second\ndescription: Second skill\n---\nSecond instructions.",
			} {
				file := filepath.Join(repo, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			run := func(args ...string) {
				t.Helper()
				if out, err := process.Command(t.Context(), repo, "git", args...).CombinedOutput(); err != nil {
					t.Fatalf("git %v: %v\n%s", args, err, out)
				}
			}
			run("init", "-b", "main")
			run("config", "user.name", "Fixture")
			run("config", "user.email", "fixture@example.invalid")
			run("config", "commit.gpgsign", "false")
			run("add", ".")
			run("commit", "-m", "Add fixture skills")
			source := "file:///" + strings.TrimPrefix(filepath.ToSlash(repo), "/")
			dataDir := ""
			if test.dataDir {
				dataDir = filepath.Join(root, "state", "data")
			}
			deps2 := enginetest.Deps(t)
			deps2.Workdir = project
			deps2.DataDir = dataDir
			deps2.Dirs = enginetest.Dirs(t, deps2.DataDir)
			deps2.Vault = vault.NewMemory()
			e, err := engine.New(deps2)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			found, err := e.SkillDiscover(t.Context(), source, "")
			if err != nil || len(found) != 2 || found[0].Name != "first" || found[0].Description != "First skill" || found[1].Name != "second" || found[1].Description != "Second skill" {
				t.Fatalf("offers=%+v err=%v", found, err)
			}
			before, err := e.SkillList(t.Context(), project)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, ok := before.Read("first"); ok {
				t.Fatal("discovering a skill installed it")
			}
			installed, err := e.SkillInstall(t.Context(), source, "", []string{"first"}, "project", project)
			if err != nil || len(installed) != 1 || installed[0] != "first" {
				t.Fatalf("installed=%v err=%v", installed, err)
			}
			listed, err := e.SkillList(t.Context(), project)
			if err != nil {
				t.Fatal(err)
			}
			body, files, ok := listed.Read("first")
			if !ok || body != "First instructions." || len(files) != 1 || files[0] != filepath.Join(project, ".merakcode", "skills", "first", "data.txt") {
				t.Fatalf("body=%q files=%v found=%v", body, files, ok)
			}
			content, err := e.ReadFile(t.Context(), project, ".merakcode/skills/first/data.txt")
			if err != nil || content.Content != "Fixture data." {
				t.Fatalf("content=%+v err=%v", content, err)
			}
			if _, _, ok := listed.Read("second"); ok {
				t.Fatal("an unselected skill was installed")
			}
			if err := e.SkillUninstall(t.Context(), "first", "project", project); err != nil {
				t.Fatal(err)
			}
			after, err := e.SkillList(t.Context(), project)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, ok := after.Read("first"); ok {
				t.Fatal("the uninstalled skill is still listed")
			}
		})
	}
}
