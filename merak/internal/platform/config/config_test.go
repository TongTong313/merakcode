package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func str(value string) *string { return &value }

func TestConfigurationPersistsProviderChangesWithoutReturningKeys(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	model := "relay/example-model"
	_, err = settings.Update(config.Patch{Model: &model, Providers: map[string]*config.ProviderPatch{"relay": {Name: str("Local relay"), Protocol: str("openai"), BaseURL: str("http://127.0.0.1:8080/v1"), APIKey: str("private-key"), Models: map[string]*config.Model{"example-model": {Window: 32000, MaxOutput: 2048}}}}})
	if err != nil {
		t.Fatal(err)
	}
	visible := settings.Get()
	if visible.Model != model || visible.Providers["relay"].APIKey != "" || !visible.Providers["relay"].HasKey {
		t.Fatalf("invalid public configuration: model=%s", visible.Model)
	}
	if _, err := settings.Update(config.Patch{Providers: map[string]*config.ProviderPatch{"relay": {Name: str("Renamed relay")}}}); err != nil {
		t.Fatal(err)
	}
	reopened, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Private().Providers["relay"].APIKey != "private-key" || reopened.Get().Providers["relay"].Name != "Renamed relay" {
		t.Fatal("provider update lost its saved key or name")
	}
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Update(config.Patch{Providers: map[string]*config.ProviderPatch{"relay": {BaseURL: str("file:///private")}}}); err == nil {
		t.Fatal("accepted invalid endpoint")
	}
	after, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("rejected configuration changed the saved file")
	}
	if strings.Contains(string(after), "hasKey") {
		t.Fatal("stored derived credential metadata")
	}
}

func TestBoardAutoArchiveDaysDefaultToThreeAndAreEditedInPlace(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	original := "{\n  // keep this comment\n  \"locale\": \"en\"\n}\n"
	if err := os.WriteFile(file, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if days := settings.Get().Board.AutoArchiveDays; days != 3 {
		t.Fatalf("default days=%d", days)
	}
	for _, days := range []int{7, 0, 14} {
		if _, err := settings.Update(config.Patch{Board: &config.BoardPatch{AutoArchiveDays: &days}}); err != nil {
			t.Fatal(err)
		}
		reopened, err := config.Open(root)
		if err != nil || reopened.Get().Board.AutoArchiveDays != days {
			t.Fatalf("after setting %d: %+v %v", days, reopened.Get().Board, err)
		}
	}
	saved, err := os.ReadFile(file)
	if err != nil || !strings.Contains(string(saved), "keep this comment") || !strings.Contains(string(saved), `"autoArchiveDays": 14`) {
		t.Fatalf("the file after the edits:\n%s %v", saved, err)
	}
	negative := -1
	if _, err := settings.Update(config.Patch{Board: &config.BoardPatch{AutoArchiveDays: &negative}}); err == nil {
		t.Fatal("a negative number of days was accepted")
	}
}

func TestSessionKeepingSettingsReadV03KeysAndDefaultToOn(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	original := "{\n  // keep this comment\n  \"snapshot\": false,\n  \"compaction\": { \"auto\": false, \"prune\": true },\n  \"storage\": { \"retention_days\": 30 }\n}\n"
	if err := os.WriteFile(file, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	got := settings.Get()
	if got.Snapshot || got.CompactionAuto || got.RetentionDays != 30 {
		t.Fatalf("snapshot=%v compaction.auto=%v retention=%d", got.Snapshot, got.CompactionAuto, got.RetentionDays)
	}
	empty := t.TempDir()
	defaults, err := config.Open(empty)
	if err != nil {
		t.Fatal(err)
	}
	if v := defaults.Get(); !v.Snapshot || !v.CompactionAuto || v.RetentionDays != 0 {
		t.Fatalf("defaults snapshot=%v compaction.auto=%v retention=%d", v.Snapshot, v.CompactionAuto, v.RetentionDays)
	}
	on, days := true, 7
	if _, err := settings.Update(config.Patch{Snapshot: &on, CompactionAuto: &on, RetentionDays: &days}); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(file)
	for _, want := range []string{"keep this comment", `"snapshot": true`, `"auto": true`, `"prune": true`, `"retention_days": 7`} {
		if !strings.Contains(string(saved), want) {
			t.Fatalf("the file lacks %q after the edit:\n%s", want, saved)
		}
	}
	negative := -1
	if _, err := settings.Update(config.Patch{RetentionDays: &negative}); err == nil {
		t.Fatal("a negative retention was accepted")
	}
}
