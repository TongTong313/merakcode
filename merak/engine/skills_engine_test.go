package engine_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
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
		integrationCall("skill", map[string]any{"name": "deploy"}),
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
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeAsk})
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
	r := &chatRig{t: t, e: e, ctx: t.Context(), dir: project, id: id}
	r.say("Deploy it")
}
