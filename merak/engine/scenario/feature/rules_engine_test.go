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
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestRulesReachTheModelInThePromptAfterReadsAndThroughTheRuleTool(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"AGENTS.md":                   "Project instructions here.",
		".merakcode/rules/always.mdc": "---\nalwaysApply: true\n---\nAlways apply me.",
		".merakcode/rules/ts.mdc":     "---\nglobs: [\"src/**/*.ts\"]\n---\nPrefer const in TypeScript.",
		".merakcode/rules/db.mdc":     "---\ndescription: Database advice\n---\nUse transactions.",
		"src/app.ts":                  "export const a = 1\n",
		"src/other.ts":                "export const b = 2\n",
		"notes.txt":                   "plain",
	} {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	toolText := func(req model.Request) string {
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
		return text.String()
	}
	provider := fake.New(t,
		enginetest.IntegrationCall("read_file", map[string]any{"path": "src/app.ts"}),
		enginetest.IntegrationCall("read_file", map[string]any{"path": "src/other.ts"}),
		enginetest.IntegrationCall("read_file", map[string]any{"path": "notes.txt"}),
		enginetest.IntegrationCall("rule", map[string]any{"name": "db"}),
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			text := toolText(req)
			if strings.Count(text, "Prefer const in TypeScript.") != 1 {
				return fmt.Errorf("the matching rule was attached %d times, want once", strings.Count(text, "Prefer const in TypeScript."))
			}
			if !strings.Contains(text, "Use transactions.") {
				return fmt.Errorf("the rule tool did not return the rule")
			}
			if strings.Contains(strings.Split(text, "export const b")[1], "Prefer const") && strings.Count(text, "Prefer const") != 1 {
				return fmt.Errorf("the second read repeated the rule")
			}
			return nil
		}},
	)
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureRules([]string{"Always answer briefly."})
	id, err := e.CreateSession(t.Context(), conversation.SessionOptions{Provider: "fake", Workdir: dir, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	state, err := e.SessionSnapshot(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	system := state.System
	order := []string{"Always answer briefly.", "Project instructions here.", "Always apply me.", "db: Database advice"}
	last := -1
	for _, want := range order {
		at := strings.Index(system, want)
		if at <= last {
			t.Fatalf("%q is missing or out of order in the system prompt:\n%s", want, system)
		}
		last = at
	}
	if strings.Contains(system, "Use transactions.") || strings.Contains(system, "Prefer const in TypeScript.") {
		t.Fatal("the body of a described or matching rule is in the system prompt")
	}
	r := &enginetest.ChatRig{T: t, Engine: e, Context: t.Context(), Directory: dir, ID: id}
	r.Say("Look around")
}
