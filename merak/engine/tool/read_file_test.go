package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestReadFileReturnsContentsOrAToolError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Project\nA local coding tool.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name      string
		input     string
		text      string
		errorCode string
	}{
		{name: "reads relative to the workspace", input: `{"path":"README.md"}`, text: "# Project\nA local coding tool.\n"},
		{name: "reports a missing file", input: `{"path":"missing.txt"}`, errorCode: "MRK-5001"},
		{name: "rejects a missing path", input: `{}`, errorCode: "MRK-5001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var reader tool.Tool = tool.ReadFile{}
			result, err := reader.Run(context.Background(), tool.Call{
				ID: "read-1", Name: "read_file", Input: json.RawMessage(test.input), Env: tool.Env{Workdir: dir},
			})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError != (test.errorCode != "") || result.Code != test.errorCode {
				t.Fatalf("result = %+v, want error code %q", result, test.errorCode)
			}
			if test.errorCode == "" && (len(result.Parts) != 1 || result.Parts[0].Text != test.text) {
				t.Fatalf("result = %+v, want %q", result, test.text)
			}
			if reader.Spec().Effect != tool.EffectRead || reader.Spec().Name != "read_file" {
				t.Fatalf("unexpected tool spec: %+v", reader.Spec())
			}
		})
	}
}
