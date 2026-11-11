package engine_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
)

func toolNames(t *testing.T, e *engine.Engine, dir string) []string {
	t.Helper()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: dir, Mode: permission.ModeAsk})
	if err != nil {
		t.Fatal(err)
	}
	state, err := e.SessionSnapshot(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, spec := range state.Tools {
		names = append(names, spec.Name)
	}
	return names
}

func TestEveryToolOfV031IsOfferedAndTheConfigurationSwitchesToolsOffByNameBeforeTheSessionStarts(t *testing.T) {
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	all := toolNames(t, e, dir)
	for _, want := range []string{"web_fetch", "web_search", "code_search", "multi_edit", "docx_read", "excel_read", "excel_write", "skill", "write_plan", "todo_write"} {
		if !slices.Contains(all, want) {
			t.Errorf("%s is not offered: %v", want, all)
		}
	}

	e.ConfigureTools(map[string]bool{"bash": false, "web_*": false, "excel_write": false, "read_file": true})
	got := toolNames(t, e, dir)
	for _, gone := range []string{"bash", "web_fetch", "web_search", "excel_write"} {
		if slices.Contains(got, gone) {
			t.Errorf("%s is still offered after it was switched off", gone)
		}
	}
	for _, kept := range []string{"read_file", "excel_read", "code_search", "edit_file"} {
		if !slices.Contains(got, kept) {
			t.Errorf("%s disappeared: %v", kept, got)
		}
	}

	e.ConfigureTools(map[string]bool{"exa": false})
	if got := toolNames(t, e, dir); slices.Contains(got, "web_search") || slices.Contains(got, "code_search") || !slices.Contains(got, "web_fetch") {
		t.Errorf("tools.exa: false must switch off both searches and nothing else: %v", got)
	}

	e.ConfigureTools(nil)
	if got := toolNames(t, e, dir); !slices.Contains(got, "bash") || !slices.Contains(got, "web_search") {
		t.Errorf("switching nothing off must offer everything again: %v", got)
	}
	if strings.Join(all, ",") != strings.Join(toolNames(t, e, dir), ",") {
		t.Error("the tool list is not stable between sessions")
	}
}
