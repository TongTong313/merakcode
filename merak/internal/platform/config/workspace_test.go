package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestWorkspaceMCPConfigurationParsesBothFilenamesAndRejectsInvalidFiles(t *testing.T) {
	for _, name := range []string{"merakcode.json", "merakcode.jsonc"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			content := `{/* comment */"mcpServers":{"docs":{"command":"node","args":["url://literal",],"env":{"TOKEN":"${SECRET}"},},},}// end`
			if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			value, err := config.ReadWorkspace(directory)
			if err != nil || value.MCPServers["docs"].Env["TOKEN"] != "${SECRET}" {
				t.Fatalf("value=%+v err=%v", value, err)
			}
			original := value.MCPServers["docs"].Hash()
			content = `{"mcpServers":{"other":{"command":"unused"},"docs":{"env":{"TOKEN":"${SECRET}"},"args":["url://literal"],"command":"node"}}}`
			if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			value, err = config.ReadWorkspace(directory)
			if err != nil || original != value.MCPServers["docs"].Hash() {
				t.Fatalf("canonical hash changed: %v", err)
			}
		})
	}
	for _, content := range []string{
		`{"unknown":true}`, `{"mcpServers":{"docs":{"command":"node","url":"https://example.com"}}}`,
		`{"mcpServers":{"bad.name":{"command":"node"}}}`, `{"mcpServers":{"":{"command":"node"}}}`,
		`{"mcpServers":{"` + strings.Repeat("a", 33) + `":{"command":"node"}}}`,
		`{"mcpServers":{"docs":{}}}`, `{"mcpServers":{"docs":{"command":"  "}}}`,
		`{"mcpServers":{"docs":{"command":"node","args":"bad"}}}`, `{"mcpServers":{"docs":{"command":"node","env":{"A":true}}}}`,
		`{"mcpServers":{"docs":{"command":"node","env":{"BAD=NAME":"value"}}}}`,
		`{"mcpServers":{"docs":{"command":"node","args":[null]}}}`,
		`{"mcpServers":{"docs":{"command":"node","env":{"A":null}}}}`,
		`{"mcpServers":{"docs":{"command":"node","args":null}}}`,
		`{"mcpServers":{"docs":{"command":"node","env":null}}}`,
		`{/* unfinished`, `{"mcpServers":{}},`, `{} {}`, `[]`, `null`, `{,}`, `{"mcpServers":{"docs":{"command":"node","args":[,]}}}`,
	} {
		t.Run(content, func(t *testing.T) {
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, "merakcode.json"), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			value, err := config.ReadWorkspace(directory)
			if err == nil || len(value.MCPServers) != 0 {
				t.Fatalf("invalid file accepted: %+v %v", value, err)
			}
		})
	}
	directory := t.TempDir()
	if value, err := config.ReadWorkspace(directory); err != nil || len(value.MCPServers) != 0 {
		t.Fatalf("missing file: %+v %v", value, err)
	}
	for _, name := range []string{"merakcode.json", "merakcode.jsonc"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(`{}`), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := config.ReadWorkspace(directory); err == nil {
		t.Fatal("ambiguous files accepted")
	}
}

func TestUserMCPSecretsStayPrivateAndWorkspaceTrustPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "merakcode.json")
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"docs":{"command":"node","env":{"TOKEN":"private-value"}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(path)
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
	settings, err = config.Open(path)
	if err != nil || len(settings.Private().WorkspaceTrust) != 2 || settings.Private().MCPServers["docs"].Env["TOKEN"] != "private-value" {
		t.Fatalf("settings=%+v err=%v", settings, err)
	}
}
