package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
)

func agentsOf(t *testing.T) []definition.Agent {
	t.Helper()
	var output bytes.Buffer
	if code := Run([]string{"agent", "list"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("list=%d %s", code, &output)
	}
	var agents []definition.Agent
	if err := json.Unmarshal(output.Bytes(), &agents); err != nil {
		t.Fatalf("%v: %s", err, &output)
	}
	return agents
}

func TestAgentCommandsListAddRemoveAndShowTheCatalog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	before := len(agentsOf(t))
	if before < 1 {
		t.Fatalf("the built-in agents are not listed: %d", before)
	}
	file := filepath.Join(home, "agent.json")
	draft := definition.DefaultMerakCode()
	draft.Name = "From a file"
	body, _ := json.Marshal(draft)
	if err := os.WriteFile(file, body, 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := Run([]string{"agent", "add", "--file", file}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("add=%d %s", code, &output)
	}
	var saved definition.Agent
	if err := json.Unmarshal(output.Bytes(), &saved); err != nil || saved.ID == "" || saved.Name != "From a file" {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	if after := len(agentsOf(t)); after != before+1 {
		t.Fatalf("agents = %d, want %d", after, before+1)
	}
	output.Reset()
	if code := Run([]string{"agent", "remove", "--agent", string(saved.ID)}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("remove=%d %s", code, &output)
	}
	if after := len(agentsOf(t)); after != before {
		t.Fatalf("agents = %d after the removal, want %d", after, before)
	}
	output.Reset()
	if code := Run([]string{"agent", "catalog"}, strings.NewReader(""), &output); code != 0 || !json.Valid(bytes.TrimSpace(output.Bytes())) {
		t.Fatalf("catalog=%d %s", code, &output)
	}
	if code := Run([]string{"member", "catalog"}, strings.NewReader(""), &output); code == 0 {
		t.Fatal("the old member command still works")
	}
}

func TestAnAgentIsAddedFromADetectedProductInOneStep(t *testing.T) {
	dir := t.TempDir()
	name := "claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	build := process.Command(context.Background(), "", "go", "build", "-o", filepath.Join(dir, name), "github.com/TongTong313/merakcode/merak/engine/collab/worker/claudecode/testdata/fakeclaude")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	t.Setenv("PATH", dir)
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	var output bytes.Buffer
	if code := Run([]string{"agent", "add", "--product", "claude-code"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("add=%d %s", code, &output)
	}
	var saved definition.Agent
	if err := json.Unmarshal(output.Bytes(), &saved); err != nil || saved.Product == nil || string(saved.Product.Kind) != "claude-code" || saved.Product.Binary == "" {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	if code := Run([]string{"agent", "add", "--product", "opencode"}, strings.NewReader(""), &output); code == 0 {
		t.Fatal("a product that was not detected was added")
	}
}
