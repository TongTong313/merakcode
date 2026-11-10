package tool_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"os"
	"path/filepath"
	"testing"
)

func TestReadCodeLimitsOperationsAndPathsToTheCheckout(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "README.md"), []byte("project text"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, operation, input string
		denied                 bool
	}{
		{"read", "read_file", `{"path":"README.md"}`, false},
		{"write", "write_file", `{"path":"README.md","content":"changed"}`, true},
		{"outside", "read_file", `{"path":"../outside.txt"}`, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := tool.ReadCode(context.Background(), directory, tool.Call{ID: "call", Name: test.operation, Input: json.RawMessage(test.input)})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError != test.denied {
				t.Fatalf("result=%+v", result)
			}
			if !test.denied && (len(result.Parts) != 1 || result.Parts[0].Text != "project text") {
				t.Fatalf("read=%+v", result)
			}
		})
	}
}
