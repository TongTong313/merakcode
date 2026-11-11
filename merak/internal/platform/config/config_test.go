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
