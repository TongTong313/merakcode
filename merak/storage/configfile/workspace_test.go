package configfile_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/storage/configfile"
)

func TestUserMCPSecretsStayPrivateAndWorkspaceTrustPersists(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "merakcode.json"), []byte(`{"mcp":{"docs":{"type":"local","command":["node"],"environment":{"TOKEN":"private-value"}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := configfile.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Get().MCPServers["docs"].Env["TOKEN"] != "" || settings.Private().MCPServers["docs"].Env["TOKEN"] != "private-value" {
		t.Fatal("public configuration disclosed or mutated credentials")
	}
	project := t.TempDir()
	for _, entry := range []config.Trust{{Project: project, Item: "mcpServers/docs", Hash: strings.Repeat("a", 64), Decision: "allow"}, {Project: project, Item: "mcpServers/docs", Hash: strings.Repeat("b", 64), Decision: "deny"}} {
		if err := settings.RememberWorkspaceTrust(entry); err != nil {
			t.Fatal(err)
		}
	}
	settings, err = configfile.Open(root)
	if err != nil || len(settings.Private().WorkspaceTrust) != 2 || settings.Private().MCPServers["docs"].Env["TOKEN"] != "private-value" {
		t.Fatalf("settings=%+v err=%v", settings, err)
	}
}
