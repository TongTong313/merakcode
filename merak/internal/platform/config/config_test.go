package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestConfigurationPersistsProviderChangesWithoutReturningKeys(t *testing.T) {
	file := filepath.Join(t.TempDir(), "merakcode.json")
	settings, err := config.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	model := "relay/example-model"
	_, err = settings.Update(config.Patch{Model: &model, Providers: map[string]*config.Provider{"relay": {Name: "Local relay", Protocol: "openai", BaseURL: "http://127.0.0.1:8080/v1", APIKey: "private-key", Models: map[string]config.Model{"example-model": {Window: 32000, MaxOutput: 2048}}}}})
	if err != nil {
		t.Fatal(err)
	}
	visible := settings.Get()
	if visible.Model != model || visible.Providers["relay"].APIKey != "" || !visible.Providers["relay"].HasKey {
		t.Fatalf("invalid public configuration: model=%s", visible.Model)
	}
	provider := visible.Providers["relay"]
	provider.Name = "Renamed relay"
	if _, err := settings.Update(config.Patch{Providers: map[string]*config.Provider{"relay": &provider}}); err != nil {
		t.Fatal(err)
	}
	reopened, err := config.Open(file)
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
	provider.BaseURL = "file:///private"
	if _, err := reopened.Update(config.Patch{Providers: map[string]*config.Provider{"relay": &provider}}); err == nil {
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
