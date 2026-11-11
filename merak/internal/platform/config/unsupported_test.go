package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

// v1 builds no language servers and no automatic formatting, like OpenCode 2. A v0.3 file that configures them still
// loads without a warning, and an edit of another key leaves them in the file untouched.
func TestLspAndFormatterKeysOfAV03FileAreKeptAndDoNothing(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	original := "{\n  // keep this comment\n  \"lsp\": { \"gopls\": { \"disabled\": true }, \"custom\": { \"command\": [\"my-lsp\", \"--stdio\"], \"extensions\": [\".xyz\"] } },\n  \"formatter\": { \"prettier\": { \"disabled\": true } },\n  \"model\": \"fake/before\"\n}\n"
	if err := os.WriteFile(file, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if warnings := settings.Get().Warnings; len(warnings) != 0 {
		t.Fatalf("keys that v0.3 knows must not warn: %v", warnings)
	}
	after := "fake/after"
	if _, err := settings.Update(config.Patch{Model: &after}); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(file)
	for _, want := range []string{"keep this comment", `"gopls": { "disabled": true }`, `"command": ["my-lsp", "--stdio"]`, `"formatter": { "prettier": { "disabled": true } }`, `"model": "fake/after"`} {
		if !strings.Contains(string(saved), want) {
			t.Fatalf("the file lacks %q after an edit of another key:\n%s", want, saved)
		}
	}
}
