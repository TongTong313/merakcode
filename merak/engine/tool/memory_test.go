package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestRememberRecallAndReadFileShareProjectNotes(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "sample.go"), []byte("package sample\n"), 0600); err != nil {
		t.Fatal(err)
	}
	repo := memory.New(storage.New())
	env := tool.Env{Workdir: dir, MemoryOwners: []memory.Owner{{Scope: memory.ScopeProject, ID: event.ID("project")}}}
	result, err := (tool.Remember{Memory: repo}).Run(ctx, tool.Call{Env: env, Input: json.RawMessage(`{"kind":"pitfall","text":"Run the sample checks before editing.","tags":["sample.go"]}`)})
	if err != nil || result.IsError {
		t.Fatalf("remember=%+v error=%v", result, err)
	}
	result, err = (tool.Recall{Memory: repo}).Run(ctx, tool.Call{Env: env, Input: json.RawMessage(`{"query":"sample checks"}`)})
	if err != nil || result.IsError || !strings.Contains(result.Parts[0].Text, "Run the sample checks") {
		t.Fatalf("recall=%+v error=%v", result, err)
	}
	result, err = (tool.ReadFile{Memory: repo}).Run(ctx, tool.Call{Env: env, Input: json.RawMessage(`{"path":"sample.go"}`)})
	if err != nil || result.IsError || len(result.Parts) != 2 || result.Parts[0].Text != "package sample\n" || !strings.Contains(result.Parts[1].Text, "Run the sample checks") {
		t.Fatalf("read=%+v error=%v", result, err)
	}
	// Absolute and relative file names recall the same tag.
	body, _ := json.Marshal(map[string]string{"path": filepath.Join(dir, "sample.go")})
	result, err = (tool.ReadFile{Memory: repo}).Run(ctx, tool.Call{Env: env, Input: body})
	if err != nil || len(result.Parts) != 2 {
		t.Fatalf("absolute read=%+v error=%v", result, err)
	}
}
