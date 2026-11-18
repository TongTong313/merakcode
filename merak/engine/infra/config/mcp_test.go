package config_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/config"
)

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
