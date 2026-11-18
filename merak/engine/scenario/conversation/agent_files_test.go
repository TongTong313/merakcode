package conversation_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAgentsDefinedInFilesAppearInTheLibraryAndSpawnUsesTheirPromptAndTools(t *testing.T) {
	project := t.TempDir()
	global := t.TempDir()
	write := func(root, name, body string) {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(project, ".merakcode/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews code\nmodel: fake/review-model\ntools: [read_file, grep]\npermission: ask\n---\nYou are the code reviewer. Find bugs.")
	write(global, "agent/helper.md", "---\ndescription: Global helper\n---\nHelp.")
	write(project, ".merakcode/modes/quick.md", "---\ndescription: Quick mode\n---\nBe quick.")

	spawned := false
	reviewer := &enginetest.Chooser{T: t}
	reviewer.Answer = func(req model.Request) []model.Chunk {
		switch {
		case strings.Contains(req.System, "You are the code reviewer"):
			return enginetest.Text("Reviewed: no bugs.")
		case !spawned:
			spawned = true
			return enginetest.Call("spawn-1", "spawn", map[string]any{"prompt": "Review src", "agent": "reviewer"})
		default:
			return enginetest.Text("Done.")
		}
	}
	deps := enginetest.Deps(t)
	deps.Workdir = project
	deps.Providers = map[string]model.Provider{"fake": reviewer}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureSkills(global, nil, nil)

	listed, err := e.ListAgentsFor(t.Context(), "owner", project)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]string{}
	for _, a := range listed {
		by[a.Name] = a.Source
	}
	if by["reviewer"] != "file" || by["helper"] != "file" || by["quick"] != "file" || by["Worker"] != "" {
		t.Fatalf("sources: %v", by)
	}
	for _, a := range listed {
		if a.Name == "reviewer" && (a.Summary != "Reviews code" || !strings.Contains(a.System, "You are the code reviewer") || a.Model.Provider != "fake" || a.Model.Model != "review-model" || len(a.Tools) != 2 || a.Mode != permission.ModeAsk) {
			t.Fatalf("reviewer=%+v", a)
		}
	}
	if without, _ := e.ListAgentsFor(t.Context(), "owner", ""); len(without) == 0 {
		t.Fatal("no built-in agents")
	} else {
		for _, a := range without {
			if a.Source == "file" && a.Name == "reviewer" {
				t.Fatal("a project agent is listed without its project")
			}
		}
	}
	for _, a := range listed {
		if a.Source == "file" {
			if _, err := e.SaveAgent(t.Context(), "owner", a); err == nil {
				t.Fatalf("an agent from a file was saved: %s", a.Name)
			}
			if err := e.DeleteAgent(t.Context(), "owner", a.ID); err == nil {
				t.Fatalf("an agent from a file was deleted: %s", a.Name)
			}
		}
	}

	id, err := e.CreateSession(t.Context(), conversation.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeAsk})
	if err != nil {
		t.Fatal(err)
	}
	r := &enginetest.ChatRig{T: t, Engine: e, Context: t.Context(), Directory: project, ID: id}
	r.Say("Please review the source")
	var seen model.Request
	enginetest.WaitFor(t, t.Context(), "the child to ask the model", func() bool {
		reviewer.Mu.Lock()
		defer reviewer.Mu.Unlock()
		if len(reviewer.Reviews) == 0 {
			return false
		}
		seen = reviewer.Reviews[0]
		return true
	})
	if seen.Model != "review-model" {
		t.Errorf("the child ran model %q, want the agent's own", seen.Model)
	}
	var names []string
	for _, spec := range seen.Tools {
		names = append(names, spec.Name)
	}
	if len(names) != 2 || !(names[0] == "grep" && names[1] == "read_file" || names[0] == "read_file" && names[1] == "grep") {
		t.Errorf("the child was offered %v, want only the tools of its agent", names)
	}
}
