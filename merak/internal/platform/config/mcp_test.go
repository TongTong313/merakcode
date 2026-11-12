package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

const mcpFile = `{
  // keep this comment
  "mcp": {
    "local": { "type": "local", "command": ["node", "server.js"], "environment": { "TOKEN": "x" } },
    "remote": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Team": "a" },
      "enabled": false,
      "timeout": 5000,
      "deferred": true,
      "oauth": { "clientId": "id", "clientSecret": "secret", "scope": "read" }
    },
    "open": { "type": "remote", "url": "http://127.0.0.1:9/mcp", "oauth": false }
  }
}
`

func TestMCPServersReadLocalAndRemoteEntriesInTheV03Format(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "merakcode.jsonc"), []byte(mcpFile), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	servers := settings.Private().MCPServers
	local, remote, open := servers["local"], servers["remote"], servers["open"]
	if local.Remote() || local.Command != "node" || len(local.Args) != 1 || local.Args[0] != "server.js" || local.Env["TOKEN"] != "x" {
		t.Fatalf("local=%+v", local)
	}
	if !remote.Remote() || remote.URL != "https://mcp.example.com/mcp" || remote.Headers["X-Team"] != "a" || !remote.Disabled || remote.Timeout != 5000 || !remote.Deferred {
		t.Fatalf("remote=%+v", remote)
	}
	if remote.OAuth == nil || remote.OAuth.ClientID != "id" || remote.OAuth.ClientSecret != "secret" || remote.OAuth.Scope != "read" || remote.NoOAuth {
		t.Fatalf("remote oauth=%+v", remote.OAuth)
	}
	if !open.NoOAuth || open.OAuth != nil {
		t.Fatalf("open=%+v", open)
	}
	if local.Hash() == remote.Hash() {
		t.Fatal("different servers share a hash")
	}
	if len(settings.Get().Warnings) != 0 {
		t.Fatalf("warnings=%v", settings.Get().Warnings)
	}
}

func TestMCPServersAreAddedChangedAndRemovedInPlace(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	if err := os.WriteFile(file, []byte(mcpFile), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	added := config.MCPServer{Type: "remote", URL: "https://added.example.com/mcp", Headers: map[string]string{"X-Key": "v"}, Timeout: 9000}
	if _, err := settings.Update(config.Patch{MCP: map[string]*config.MCPServer{"added": &added, "local": nil}}); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(file)
	for _, want := range []string{"keep this comment", `"added"`, `"type": "remote"`, "https://added.example.com/mcp", `"X-Key"`, `"remote"`} {
		if !strings.Contains(string(text), want) {
			t.Fatalf("the file lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(string(text), `"local"`) {
		t.Fatalf("the deleted server is still in the file:\n%s", text)
	}
	reopened, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	servers := reopened.Private().MCPServers
	if len(servers) != 3 || servers["added"].URL != "https://added.example.com/mcp" || servers["added"].Timeout != 9000 || servers["local"].Command != "" {
		t.Fatalf("servers=%+v", servers)
	}
	disabled := true
	if _, err := reopened.Update(config.Patch{MCP: map[string]*config.MCPServer{"added": {Type: "remote", URL: "https://added.example.com/mcp", Disabled: disabled}}}); err != nil {
		t.Fatal(err)
	}
	if again, _ := config.Open(root); !again.Private().MCPServers["added"].Disabled {
		t.Fatal("a server was not disabled")
	}
	if _, err := reopened.Update(config.Patch{MCP: map[string]*config.MCPServer{"bad": {Type: "remote", URL: "file:///etc/passwd"}}}); err == nil {
		t.Fatal("a remote server with a file URL was accepted")
	}
	if _, err := reopened.Update(config.Patch{MCP: map[string]*config.MCPServer{"bad name": {Command: "node"}}}); err == nil {
		t.Fatal("a server with a bad name was accepted")
	}
}

func TestInvalidMCPServersFailValidationWithoutBreakingTheOthers(t *testing.T) {
	for name, server := range map[string]config.MCPServer{
		"remote without url":    {Type: "remote"},
		"remote with command":   {Type: "remote", URL: "https://a.example/mcp", Command: "node"},
		"remote bad header":     {Type: "remote", URL: "https://a.example/mcp", Headers: map[string]string{"Bad Name": "x"}},
		"local without command": {Type: "local"},
		"unknown type":          {Type: "pipe", Command: "node"},
		"negative timeout":      {Command: "node", Timeout: -1},
	} {
		if err := config.ValidateMCPServers(map[string]config.MCPServer{"one": server}); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if err := config.ValidateMCPServers(map[string]config.MCPServer{"fine": {Type: "remote", URL: "http://localhost:3000/mcp"}, "also": {Command: "node"}}); err != nil {
		t.Fatalf("valid servers were rejected: %v", err)
	}
}

func TestALocalMcpServerWithoutACommandIsSkippedWithAWarningAndTheRestOfTheFileLoads(t *testing.T) {
	for name, entry := range map[string]string{
		"no command":    `{ "type": "local" }`,
		"empty command": `{ "type": "local", "command": [] }`,
		"null part":     `{ "type": "local", "command": ["node", null] }`,
		"remote no url": `{ "type": "remote" }`,
	} {
		t.Run(name, func(t *testing.T) {
			settings, file := openText(t, `{ "model": "fake/m", "mcp": { "broken": `+entry+`, "good": { "type": "local", "command": ["node", "ok.mjs"] } } }`)
			got := settings.Get()
			if got.Model != "fake/m" {
				t.Fatalf("the rest of the file must load: %+v", got)
			}
			if _, ok := got.MCPServers["broken"]; ok {
				t.Fatal("the unusable entry must be skipped")
			}
			if good := got.MCPServers["good"]; good.Command != "node" {
				t.Fatalf("a good entry next to it must stay: %+v", got.MCPServers)
			}
			if len(got.Warnings) != 1 || got.Warnings[0].Path != "mcp.broken" || got.Warnings[0].Code != "MRK-3002" || got.Warnings[0].File != file {
				t.Fatalf("warnings = %v", got.Warnings)
			}
		})
	}
}
