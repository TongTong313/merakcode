package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestMultiEditAppliesEveryReplacementInOrderOrChangesNothing(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "main.go")
	original := "alpha\nbeta\ngamma\nbeta\n"
	reads := new(tool.Reads)
	env := tool.Env{Workdir: dir, Reads: reads}
	write := func() {
		if err := os.WriteFile(file, []byte(original), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := (tool.ReadFile{}).Run(context.Background(), tool.Call{Input: json.RawMessage(`{"path":"main.go"}`), Env: env}); err != nil {
			t.Fatal(err)
		}
	}
	run := func(edits any) tool.Result {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"path": "main.go", "edits": edits})
		result, err := (tool.MultiEdit{}).Run(context.Background(), tool.Call{Input: body, Env: env})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	pair := func(old, new string) map[string]string { return map[string]string{"oldText": old, "newText": new} }

	write()
	if result := run([]any{pair("alpha", "ALPHA"), pair("gamma", "GAMMA")}); result.IsError {
		t.Fatalf("result=%+v", result)
	}
	if got, _ := os.ReadFile(file); string(got) != "ALPHA\nbeta\nGAMMA\nbeta\n" {
		t.Fatalf("file=%q", got)
	}

	write()
	if result := run([]any{pair("alpha", "beta"), pair("beta\nbeta", "x")}); result.IsError {
		t.Fatalf("a later edit sees the result of an earlier one: %+v", result)
	}
	if got, _ := os.ReadFile(file); string(got) != "x\ngamma\nbeta\n" {
		t.Fatalf("file=%q: the second edit must see the text the first one produced", got)
	}

	for name, edits := range map[string][]any{
		"a missing text":      {pair("alpha", "A"), pair("nowhere", "B")},
		"an ambiguous text":   {pair("alpha", "A"), pair("beta", "B")},
		"an empty old text":   {pair("", "x")},
		"no edits":            {},
		"the same text twice": {pair("gamma", "g"), pair("gamma", "G")},
	} {
		write()
		result := run(edits)
		if !result.IsError {
			t.Errorf("%s was accepted", name)
		}
		if got, _ := os.ReadFile(file); string(got) != original {
			t.Errorf("%s changed the file: %q", name, got)
		}
		if name == "a missing text" && !strings.Contains(result.Parts[0].Text, "2") {
			t.Errorf("the failure does not say which edit failed: %q", result.Parts[0].Text)
		}
	}

	write()
	if err := os.WriteFile(file, []byte(original+"changed behind our back\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if result := run([]any{pair("alpha", "A")}); !result.IsError {
		t.Error("a file that changed since it was read was edited")
	}
	if (tool.MultiEdit{}).Spec().Effect != tool.EffectWrite {
		t.Error("multi_edit must go through the same permission gate as edit_file")
	}
}
