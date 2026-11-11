package config_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestWorkspaceMCPConfigurationParsesBothFilenamesAndRejectsInvalidFiles(t *testing.T) {
	for _, name := range []string{"merakcode.json", "merakcode.jsonc"} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			content := `{/* comment */"mcp":{"docs":{"type":"local","command":["node","url://literal",],"environment":{"TOKEN":"${SECRET}"},},},}// end`
			if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			value, err := config.ReadWorkspace(directory)
			if err != nil || value.MCPServers["docs"].Env["TOKEN"] != "${SECRET}" || !slices.Equal(value.MCPServers["docs"].Args, []string{"url://literal"}) {
				t.Fatalf("value=%+v err=%v", value, err)
			}
			original := value.MCPServers["docs"].Hash()
			content = `{"mcp":{"other":{"type":"local","command":["unused"]},"docs":{"environment":{"TOKEN":"${SECRET}"},"command":["node","url://literal"],"type":"local"}}}`
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
		`{"mcp":{"bad.name":{"type":"local","command":["node"]}}}`, `{"mcp":{"":{"type":"local","command":["node"]}}}`,
		`{"mcp":{"` + strings.Repeat("a", 33) + `":{"type":"local","command":["node"]}}}`,
		`{"mcp":{"docs":{"type":"local"}}}`, `{"mcp":{"docs":{"type":"local","command":[]}}}`,
		`{"mcp":{"docs":{"type":"local","command":["  "]}}}`, `{"mcp":{"docs":{"type":"local","command":"node"}}}`,
		`{"mcp":{"docs":{"type":"local","command":["node"],"environment":{"A":true}}}}`,
		`{"mcp":{"docs":{"type":"local","command":["node"],"environment":{"BAD=NAME":"value"}}}}`,
		`{"mcp":{"docs":{"type":"local","command":["node",null]}}}`,
		`{/* unfinished`, `{"mcp":{}},`, `{} {}`, `[]`, `null`, `{,}`, `{"mcp":{"docs":{"type":"local","command":[,]}}}`,
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
}

func TestWorkspaceConfigurationReportsUnknownKeysAndMergesEveryFile(t *testing.T) {
	directory := t.TempDir()
	if err := os.MkdirAll(filepath.Join(directory, ".merakcode"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"merakcode.json": `{"unknown":true,"mcp":{"a":{"type":"local","command":["one"]},"b":{"type":"local","command":["old"]}}}`,
		filepath.Join(".merakcode", "merakcode.jsonc"): `{"mcp":{"b":{"type":"local","command":["new"]}}}`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	value, err := config.ReadWorkspace(directory)
	if err != nil || value.MCPServers["a"].Command != "one" || value.MCPServers["b"].Command != "new" {
		t.Fatalf("value=%+v err=%v", value, err)
	}
	if !slices.ContainsFunc(value.Warnings, func(w config.Warning) bool { return strings.Contains(w.String(), "unknown") }) {
		t.Fatalf("warnings=%v", value.Warnings)
	}
}

func TestUserMCPSecretsStayPrivateAndWorkspaceTrustPersists(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "merakcode.json"), []byte(`{"mcp":{"docs":{"type":"local","command":["node"],"environment":{"TOKEN":"private-value"}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
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
	settings, err = config.Open(root)
	if err != nil || len(settings.Private().WorkspaceTrust) != 2 || settings.Private().MCPServers["docs"].Env["TOKEN"] != "private-value" {
		t.Fatalf("settings=%+v err=%v", settings, err)
	}
}
