package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func providerList(t *testing.T) map[string]struct {
	HasKey  bool   `json:"hasKey"`
	Station string `json:"station"`
} {
	t.Helper()
	var output bytes.Buffer
	if code := Run([]string{"provider", "list"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("list=%d %s", code, output.String())
	}
	var providers map[string]struct {
		HasKey  bool   `json:"hasKey"`
		Station string `json:"station"`
	}
	if err := json.Unmarshal(output.Bytes(), &providers); err != nil {
		t.Fatalf("%v: %s", err, output.String())
	}
	return providers
}

func TestProviderCommandsKeepKeysOutOfTheConfigurationFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	for _, name := range []string{"DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"} {
		t.Setenv(name, "")
	}
	if providers := providerList(t); providers["deepseek"].HasKey {
		t.Fatal("a provider has a key before login")
	}
	var output bytes.Buffer
	if code := Run([]string{"provider", "login", "deepseek"}, strings.NewReader("sk-private\n"), &output); code != 0 {
		t.Fatalf("login=%d %s", code, output.String())
	}
	if providers := providerList(t); !providers["deepseek"].HasKey {
		t.Fatal("login did not save the key")
	}
	if text, _ := os.ReadFile(filepath.Join(home, "merakcode.jsonc")); strings.Contains(string(text), "sk-private") {
		t.Fatalf("the key reached the configuration file:\n%s", text)
	}
	output.Reset()
	if code := Run([]string{"provider", "list"}, strings.NewReader(""), &output); code != 0 || strings.Contains(output.String(), "sk-private") {
		t.Fatalf("list=%d %s", code, output.String())
	}
	if code := Run([]string{"provider", "logout", "deepseek"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("logout=%d", code)
	}
	if providers := providerList(t); providers["deepseek"].HasKey {
		t.Fatal("logout kept the key")
	}
}

func TestRelayStationsAreAddedAndRemoved(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	var output bytes.Buffer
	args := []string{"provider", "relay", "add", "packy", "--url", "https://relay.example/v1", "--station", "packy", "--group", "standard"}
	if code := Run(args, strings.NewReader("sk-relay\n"), &output); code != 0 {
		t.Fatalf("add=%d %s", code, output.String())
	}
	providers := providerList(t)
	if !providers["packy"].HasKey || providers["packy"].Station != "packy" {
		t.Fatalf("relay=%+v", providers["packy"])
	}
	if code := Run([]string{"provider", "relay", "remove", "packy"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("remove=%d", code)
	}
	if _, ok := providerList(t)["packy"]; ok {
		t.Fatal("the relay is still listed")
	}
	if text, _ := os.ReadFile(filepath.Join(home, "merakcode.jsonc")); strings.Contains(string(text), "sk-relay") || strings.Contains(string(text), "packy") {
		t.Fatalf("the configuration file still has the relay:\n%s", text)
	}
}
