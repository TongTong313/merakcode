package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestAgentSectionAndDefaultAgentReadTheV03KeysAndPlanIsReported(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	text := `{
  // keep this comment
  "default_agent": "reviewer",
  "agent": {
    "build": { "model": "fake/big", "prompt": "Build carefully.", "tools": { "bash": false, "web*": true }, "description": "Builds" },
    "title": { "model": "fake/tiny" },
    "plan": { "model": "fake/never" },
    "reviewer": { "prompt": "Review only.", "temperature": 0.1 },
    "broken": "not an object"
  }
}
`
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	got := settings.Get()
	if got.DefaultAgent != "reviewer" {
		t.Fatalf("default agent = %q", got.DefaultAgent)
	}
	build := got.Agents["build"]
	if build.Model != "fake/big" || build.Prompt != "Build carefully." || build.Description != "Builds" || build.Tools["bash"] || !build.Tools["web*"] {
		t.Fatalf("build = %+v", build)
	}
	if got.Agents["title"].Model != "fake/tiny" || got.Agents["reviewer"].Prompt != "Review only." {
		t.Fatalf("agents = %+v", got.Agents)
	}
	if _, kept := got.Agents["plan"]; kept {
		t.Fatal("plan has no meaning without a planning mode and must not be kept")
	}
	reported := map[string]bool{}
	for _, warning := range got.Warnings {
		reported[warning.Path] = warning.Code == "MRK-3002"
	}
	if !reported["agent.plan"] || !reported["agent.broken"] || !reported["agent.reviewer.temperature"] {
		t.Fatalf("warnings = %v", got.Warnings)
	}
	choice := "build"
	if _, err := settings.Update(config.Patch{DefaultAgent: &choice}); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(file)
	for _, want := range []string{"keep this comment", `"default_agent": "build"`, `"prompt": "Review only."`} {
		if !strings.Contains(string(saved), want) {
			t.Fatalf("the file lacks %q after the edit:\n%s", want, saved)
		}
	}
}
