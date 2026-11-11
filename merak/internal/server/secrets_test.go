package server_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// keyFixture runs a provider that remembers the authorization header of its last model list request.
type keyFixture struct {
	home, host string
	seen       atomic.Value
	vault      *credential.Store
	server     *httptest.Server
}

func newKeyFixture(t *testing.T) *keyFixture {
	t.Helper()
	f := &keyFixture{home: t.TempDir(), vault: credential.NewFile(t.TempDir())}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.seen.Store(r.Header.Get("Authorization"))
		io.WriteString(w, `{"data":[{"id":"chat-model"}]}`)
	}))
	t.Cleanup(f.server.Close)
	return f
}

// start hosts an engine on the fixture's home with the fixture's vault.
func (f *keyFixture) start(t *testing.T) (*protocol.Client, func()) {
	t.Helper()
	e, err := engine.New(engine.Deps{Workdir: f.home, Vault: f.vault})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.StartWith(e, server.Options{Data: filepath.Join(f.home, "data"), Config: f.home, Address: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	client, err := protocol.Connect(t.Context(), instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	return client, func() { client.Close(); instance.Close(); e.Close() }
}

func (f *keyFixture) refreshSends(t *testing.T, client *protocol.Client, provider string) string {
	t.Helper()
	f.seen.Store("")
	var models []any
	if err := client.Call(t.Context(), "model.refresh", protocol.ModelRefreshParams{Provider: provider}, &models); err != nil {
		t.Fatal(err)
	}
	return f.seen.Load().(string)
}

func (f *keyFixture) configFile(t *testing.T) string {
	t.Helper()
	text, _ := os.ReadFile(filepath.Join(f.home, "merakcode.jsonc"))
	if len(text) == 0 {
		text, _ = os.ReadFile(filepath.Join(f.home, "merakcode.json"))
	}
	return string(text)
}

func TestProviderKeysLiveInTheVaultAndNotInTheConfigurationFile(t *testing.T) {
	f := newKeyFixture(t)
	client, stop := f.start(t)
	var value protocol.Config
	patch := map[string]any{"providers": map[string]any{"relay": map[string]any{"protocol": "openai", "baseURL": f.server.URL, "apiKey": "private-key"}}}
	if err := client.Call(t.Context(), "config.set", patch, &value); err != nil {
		t.Fatal(err)
	}
	if !value.Providers["relay"].HasKey || value.Providers["relay"].APIKey != "" {
		t.Fatalf("public provider = %+v", value.Providers["relay"])
	}
	if got := f.configFile(t); strings.Contains(got, "private-key") || !strings.Contains(got, f.server.URL) {
		t.Fatalf("configuration file:\n%s", got)
	}
	if sent := f.refreshSends(t, client, "relay"); sent != "Bearer private-key" {
		t.Fatalf("the provider received %q", sent)
	}
	stop()

	client, stop = f.start(t)
	defer stop()
	if sent := f.refreshSends(t, client, "relay"); sent != "Bearer private-key" {
		t.Fatalf("after a restart the provider received %q", sent)
	}
	var again protocol.Config
	if err := client.Call(t.Context(), "config.get", struct{}{}, &again); err != nil || !again.Providers["relay"].HasKey {
		t.Fatalf("after a restart: %+v %v", again.Providers["relay"], err)
	}
	var cleared protocol.Config
	if err := client.Call(t.Context(), "config.set", map[string]any{"providers": map[string]any{"relay": map[string]any{"apiKey": ""}}}, &cleared); err != nil || cleared.Providers["relay"].HasKey {
		t.Fatalf("a key was not removed: %+v %v", cleared.Providers["relay"], err)
	}
}

func TestKeysFoundInTheFilesOfEarlierVersionsMoveIntoTheVault(t *testing.T) {
	f := newKeyFixture(t)
	file := fmt.Sprintf(`{
  // my providers
  "provider": { "relay": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": %q, "apiKey": "legacy-key" } } }
}
`, f.server.URL)
	if err := os.WriteFile(filepath.Join(f.home, "merakcode.jsonc"), []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(f.home, "data"), 0700); err != nil {
		t.Fatal(err)
	}
	authFile := filepath.Join(f.home, "data", "auth.json")
	if err := os.WriteFile(authFile, []byte(`{"deepseek":{"type":"api","key":"auth-file-key"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	client, stop := f.start(t)
	defer stop()
	if got := f.configFile(t); strings.Contains(got, "legacy-key") || !strings.Contains(got, "// my providers") {
		t.Fatalf("configuration file:\n%s", got)
	}
	if _, err := os.Stat(authFile); !os.IsNotExist(err) {
		t.Fatalf("auth.json was not removed: %v", err)
	}
	if sent := f.refreshSends(t, client, "relay"); sent != "Bearer legacy-key" {
		t.Fatalf("relay received %q", sent)
	}
	var value protocol.Config
	if err := client.Call(t.Context(), "config.get", struct{}{}, &value); err != nil || !value.Providers["deepseek"].HasKey {
		t.Fatalf("the key of auth.json is missing: %+v %v", value.Providers["deepseek"], err)
	}
}
