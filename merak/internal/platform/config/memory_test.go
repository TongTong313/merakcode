package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestMemorySettingsReadTheV03KeysDefaultToOffAndAreEditedInPlace(t *testing.T) {
	empty, err := config.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got := empty.Get().Memory; got.AutoExtract || got.AutoRecall || got.Model != "" {
		t.Fatalf("defaults=%+v", got)
	}

	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	original := "{\n  // keep this comment\n  \"memory\": { \"auto_extract\": \"signals\", \"auto_recall\": true, \"model\": \"fake/small\", \"session_memory\": false }\n}\n"
	if err := os.WriteFile(file, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	got := settings.Get()
	if !got.Memory.AutoExtract || !got.Memory.AutoRecall || got.Memory.Model != "fake/small" {
		t.Fatalf("memory=%+v", got.Memory)
	}
	if len(got.Warnings) != 1 || got.Warnings[0].Path != "memory.session_memory" || got.Warnings[0].Code != "MRK-3002" || got.Warnings[0].File != file {
		t.Fatalf("an unused memory key must be reported, warnings=%v", got.Warnings)
	}
	for _, text := range []string{`"auto_extract": false`, `"auto_extract": "always"`} {
		if err := os.WriteFile(filepath.Join(t.TempDir(), "x"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "merakcode.jsonc"), []byte("{"+strings.Replace(text, `"auto_extract"`, `"memory": {"auto_extract"`, 1)+"}}"), 0o600); err != nil {
			t.Fatal(err)
		}
		parsed, err := config.Open(dir)
		if err != nil || parsed.Get().Memory.AutoExtract != strings.Contains(text, "always") {
			t.Fatalf("%s: %+v err=%v", text, parsed.Get().Memory, err)
		}
	}

	off := false
	if _, err := settings.Update(config.Patch{Memory: &config.MemoryPatch{AutoRecall: &off}}); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(file)
	for _, want := range []string{"keep this comment", `"auto_recall": false`, `"auto_extract": "signals"`, `"model": "fake/small"`} {
		if !strings.Contains(string(saved), want) {
			t.Fatalf("the file lacks %q after the edit:\n%s", want, saved)
		}
	}
	on := true
	model := "fake/other"
	if _, err := settings.Update(config.Patch{Memory: &config.MemoryPatch{AutoExtract: &on, Model: &model}}); err != nil {
		t.Fatal(err)
	}
	again, _ := config.Open(root)
	if !again.Get().Memory.AutoExtract || again.Get().Memory.Model != "fake/other" || again.Get().Memory.AutoRecall {
		t.Fatalf("memory=%+v", again.Get().Memory)
	}
}
