package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func acpMCPServers(raw []json.RawMessage) (map[string]protocol.MCPServer, error) {
	servers := make(map[string]protocol.MCPServer, len(raw))
	for _, body := range raw {
		var input struct {
			Name    string   `json:"name"`
			Type    string   `json:"type,omitempty"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
			Env     []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"env"`
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || input.Type != "" && input.Type != "stdio" {
			return nil, errors.New("invalid stdio MCP server")
		}
		if _, exists := servers[input.Name]; exists {
			return nil, errors.New("duplicate MCP server")
		}
		server := protocol.MCPServer{Command: input.Command, Args: input.Args, Env: map[string]string{}}
		for _, variable := range input.Env {
			if _, exists := server.Env[variable.Name]; exists {
				return nil, errors.New("duplicate MCP environment variable")
			}
			server.Env[variable.Name] = variable.Value
		}
		servers[input.Name] = server
	}
	return servers, config.ValidateMCPServers(servers)
}
