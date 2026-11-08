package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestEditFileRequiresExactlyOneMatch(t *testing.T) {
	for _, test := range []struct {
		name        string
		before      string
		old         string
		replacement string
		after       string
		isError     bool
	}{
		{"replaces a unique match", "Hello world\n", "world", "MerakCode", "Hello MerakCode\n", false},
		{"rejects duplicate matches", "one one\n", "one", "two", "one one\n", true},
		{"rejects a missing match", "Hello\n", "world", "MerakCode", "Hello\n", true},
		{"rejects an empty match", "Hello\n", "", "anything", "Hello\n", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "notes.txt")
			if err := os.WriteFile(path, []byte(test.before), 0o600); err != nil {
				t.Fatal(err)
			}
			input, err := json.Marshal(map[string]string{"path": "notes.txt", "oldText": test.old, "newText": test.replacement})
			if err != nil {
				t.Fatal(err)
			}
			env := tool.Env{Workdir: dir, Reads: new(tool.Reads)}
			if _, err := (tool.ReadFile{}).Run(context.Background(), tool.Call{Input: []byte(`{"path":"notes.txt"}`), Env: env}); err != nil {
				t.Fatal(err)
			}
			result, err := (tool.EditFile{}).Run(context.Background(), tool.Call{Input: input, Env: env})
			if err != nil || result.IsError != test.isError {
				t.Fatalf("edit = %+v, error = %v", result, err)
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != test.after {
				t.Fatalf("contents = %q, error = %v, want %q", data, err, test.after)
			}
		})
	}
}

func TestEditFileRejectsChangesSinceTheLastRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(path, []byte("one\noriginal"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := tool.Env{Workdir: dir, Reads: new(tool.Reads)}
	if result, err := (tool.ReadFile{}).Run(context.Background(), tool.Call{Input: []byte(`{"path":"notes.txt"}`), Env: env}); err != nil || result.IsError {
		t.Fatalf("read=%+v error=%v", result, err)
	}
	if err := os.WriteFile(path, []byte("one\nexternal"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := (tool.EditFile{}).Run(context.Background(), tool.Call{Input: []byte(`{"path":"notes.txt","oldText":"one","newText":"two"}`), Env: env})
	if err != nil || !result.IsError {
		t.Fatalf("stale edit=%+v error=%v", result, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "one\nexternal" {
		t.Fatalf("external content overwritten: %q, %v", data, err)
	}
}
