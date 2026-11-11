package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/skill"
)

func TestSkillAndCommandCommandsListInstallAndUninstall(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			fmt.Fprint(w, `{"skills":[{"name":"lint","description":"Run linters","files":["SKILL.md"]}]}`)
		case "/lint/SKILL.md":
			fmt.Fprint(w, "---\nname: lint\ndescription: Run linters\n---\nRun them.")
		default:
			http.NotFound(w, r)
		}
	}))
	defer source.Close()
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".merakcode", "commands"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".merakcode", "commands", "deploy.md"), []byte("Deploy $ARGUMENTS"), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: project})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	run := func(args ...string) (int, string) {
		var out bytes.Buffer
		code := Run(args, strings.NewReader(""), &out)
		return code, out.String()
	}

	var skills struct {
		Skills []skill.Skill `json:"skills"`
	}
	if code, out := run("skill", "list", "--directory", project); code != 0 || json.Unmarshal([]byte(out), &skills) != nil || len(skills.Skills) < 3 {
		t.Fatalf("skill list=%d %s", code, out)
	}
	if code, out := run("skill", "install", source.URL, "--name", "lint", "--directory", project); code != 0 {
		t.Fatalf("install=%d %s", code, out)
	}
	if _, err := os.Stat(filepath.Join(project, ".merakcode", "skills", "lint", "SKILL.md")); err != nil {
		t.Fatalf("the skill was not installed: %v", err)
	}
	if code, out := run("skill", "list", "--directory", project); code != 0 || !strings.Contains(out, `"lint"`) {
		t.Fatalf("list after the install=%d %s", code, out)
	}
	if code, out := run("skill", "uninstall", "lint", "--directory", project); code != 0 {
		t.Fatalf("uninstall=%d %s", code, out)
	}
	if _, err := os.Stat(filepath.Join(project, ".merakcode", "skills", "lint")); err == nil {
		t.Fatal("the skill is still installed")
	}
	if code, _ := run("skill", "install", source.URL, "--directory", project); code != 2 {
		t.Fatalf("an install without a name must be a usage error, got %d", code)
	}

	var commands []command.Command
	if code, out := run("command", "list", "--directory", project); code != 0 || json.Unmarshal([]byte(out), &commands) != nil {
		t.Fatalf("command list=%d %s", code, out)
	}
	found := map[string]bool{}
	for _, c := range commands {
		found[c.Name] = true
	}
	if !found["init"] || !found["deploy"] || !found["pdf"] {
		t.Fatalf("commands=%v", found)
	}
}
