package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestWriteFileCreatesAndReplacesFileContents(t *testing.T) {
	dir := t.TempDir()
	writer := tool.WriteFile{}
	for _, content := range []string{"First version\n", "Replaced\n", ""} {
		input, err := json.Marshal(map[string]string{"path": "notes.txt", "content": content})
		if err != nil {
			t.Fatal(err)
		}
		result, err := writer.Run(context.Background(), tool.Call{Input: input, Env: tool.Env{Workdir: dir}})
		if err != nil || result.IsError {
			t.Fatalf("write = %+v, error = %v", result, err)
		}
		data, err := os.ReadFile(filepath.Join(dir, "notes.txt"))
		if err != nil || string(data) != content {
			t.Fatalf("contents = %q, error = %v, want %q", data, err, content)
		}
	}
	if writer.Spec().Effect != tool.EffectWrite {
		t.Fatal("write_file must require approval")
	}
}
