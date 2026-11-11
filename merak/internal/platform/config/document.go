package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"
)

// v03Keys are the top-level keys of the v0.3 configuration schema; v1 reads, keeps and writes them in v0.3 format.
var v03Keys = []string{
	"$schema", "locale", "logLevel", "server", "command", "skills", "watcher", "plugin", "agentConnections",
	"collaboration", "snapshot", "disabled_providers", "enabled_providers", "model", "small_model", "default_agent",
	"mode", "agent", "provider", "mcp", "formatter", "lsp", "instructions", "rules", "layout", "permission", "tools",
	"enterprise", "compaction", "memory", "tool_discovery", "experimental", "ui", "plugin_options", "storage",
	"sandbox",
}

// v1Keys are the top-level keys that only v1 has. None of them may share a name with a v0.3 key.
var v1Keys = []string{
	"cloud", "permissionMode", "workspaceTrust", "permissionRules", "permissionGrants", "unconfined", "allowedHosts",
	"deniedHosts", "thinking", "board",
}

// ignoredKeys are v0.3 keys that v1 does not use any more.
var ignoredKeys = []string{"mode", "layout", "enterprise", "tool_discovery", "experimental"}

type fileModel struct {
	Name  string `json:"name"`
	Limit struct {
		Context int `json:"context"`
		Output  int `json:"output"`
	} `json:"limit"`
	Variants map[string]struct {
		Disabled bool `json:"disabled"`
	} `json:"variants"`
}

type fileProvider struct {
	Name    string     `json:"name"`
	NPM     string     `json:"npm"`
	Picker  *Picker    `json:"picker"`
	Relay   *fileRelay `json:"relay"`
	Options struct {
		BaseURL string            `json:"baseURL"`
		APIKey  string            `json:"apiKey"`
		Headers map[string]string `json:"headers"`
		Auth    string            `json:"auth"`
	} `json:"options"`
	Models map[string]fileModel `json:"models"`
}

type fileRelay struct {
	Station string `json:"station"`
	Group   string `json:"group"`
	Kind    string `json:"kind"`
	Auth    string `json:"auth"`
}

type fileMCP struct {
	Type        string             `json:"type"`
	Command     []*string          `json:"command"`
	Environment map[string]*string `json:"environment"`
}

type fileServer struct {
	Port     int    `json:"port"`
	Hostname string `json:"hostname"`
}

// parseFile reads a configuration file: JSON with comments and trailing commas whose top level is an object.
func parseFile(text []byte) (map[string]json.RawMessage, error) {
	clean, err := cleanJSONC(text)
	if err != nil {
		return nil, err
	}
	clean = bytes.TrimSpace(clean)
	if len(clean) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	if clean[0] != '{' {
		return nil, errors.New("configuration must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(clean))
	var top map[string]json.RawMessage
	if err := decoder.Decode(&top); err != nil || top == nil {
		return nil, errors.New("invalid configuration")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("expected one configuration object")
	}
	return top, nil
}

func decodeKey(top map[string]json.RawMessage, key string, target any) error {
	raw, ok := top[key]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("invalid %s", key)
	}
	return nil
}

// buildValue turns the parsed file into a value. Keys that v1 does not know or does not use are listed in the
// warnings, not rejected.
func buildValue(top map[string]json.RawMessage) (Value, error) {
	value := Value{Providers: map[string]Provider{}}
	var level, localeText string
	var disabled []string
	var server fileServer
	var rules struct {
		User []string `json:"user"`
	}
	var board struct {
		AutoArchiveDays *int `json:"autoArchiveDays"`
	}
	var mcp map[string]json.RawMessage
	var providers map[string]fileProvider
	for _, field := range []struct {
		key    string
		target any
	}{
		{"locale", &localeText}, {"logLevel", &level}, {"model", &value.Model}, {"small_model", &value.SmallModel},
		{"thinking", &value.Thinking}, {"enabled_providers", &value.EnabledProviders}, {"disabled_providers", &disabled},
		{"server", &server}, {"board", &board}, {"rules", &rules}, {"mcp", &mcp}, {"provider", &providers}, {"cloud", &value.Cloud},
		{"permissionMode", &value.PermissionMode}, {"workspaceTrust", &value.WorkspaceTrust},
		{"permissionRules", &value.PermissionRules}, {"permissionGrants", &value.PermissionGrants},
		{"unconfined", &value.Unconfined}, {"allowedHosts", &value.AllowedHosts}, {"deniedHosts", &value.DeniedHosts},
	} {
		if err := decodeKey(top, field.key, field.target); err != nil {
			return Value{}, err
		}
	}
	value.Locale, value.Log, value.Rules.User = localeText, strings.ToLower(level), rules.User
	if raw, ok := top["permission"]; ok {
		mapped, warnings := permissionRules(raw)
		value.PermissionRules = append(value.PermissionRules, mapped...)
		value.Warnings = append(value.Warnings, warnings...)
	}
	value.Server = Server{Port: server.Port, Hostname: server.Hostname}
	value.Board.AutoArchiveDays = DefaultAutoArchiveDays
	if board.AutoArchiveDays != nil {
		value.Board.AutoArchiveDays = *board.AutoArchiveDays
	}
	for id, source := range providers {
		value.Providers[id] = providerView(source)
	}
	for _, id := range disabled {
		provider := value.Providers[id]
		provider.Disabled = true
		value.Providers[id] = provider
	}
	for name, raw := range mcp {
		var source fileMCP
		if err := json.Unmarshal(raw, &source); err != nil {
			return Value{}, fmt.Errorf("invalid mcp.%s", name)
		}
		if source.Type != "local" {
			value.Warnings = append(value.Warnings, "mcp."+name+": remote servers are not supported yet")
			continue
		}
		if len(source.Command) == 0 {
			return Value{}, fmt.Errorf("invalid mcp.%s", name)
		}
		if value.MCPServers == nil {
			value.MCPServers = map[string]MCPServer{}
		}
		server, err := mcpServer(name, source)
		if err != nil {
			return Value{}, err
		}
		value.MCPServers[name] = server
	}
	value.Warnings = append(value.Warnings, keyWarnings(top)...)
	var extra map[string]json.RawMessage
	_ = decodeKey(top, "server", &extra)
	for _, name := range []string{"mdns", "mdnsDomain", "cors"} {
		if _, ok := extra[name]; ok {
			value.Warnings = append(value.Warnings, "server."+name+": this key is not used and is ignored")
		}
	}
	return value, nil
}

// mcpServer converts a local server definition; null entries are rejected.
func mcpServer(name string, source fileMCP) (MCPServer, error) {
	var server MCPServer
	for i, part := range source.Command {
		if part == nil {
			return MCPServer{}, fmt.Errorf("invalid mcp.%s", name)
		}
		if i == 0 {
			server.Command = *part
			continue
		}
		server.Args = append(server.Args, *part)
	}
	if len(source.Environment) > 0 {
		server.Env = make(map[string]string, len(source.Environment))
	}
	for key, value := range source.Environment {
		if value == nil {
			return MCPServer{}, fmt.Errorf("invalid mcp.%s", name)
		}
		server.Env[key] = *value
	}
	return server, nil
}

func providerView(source fileProvider) Provider {
	provider := Provider{Name: source.Name, BaseURL: source.Options.BaseURL, APIKey: source.Options.APIKey, Headers: source.Options.Headers, Picker: source.Picker, Auth: source.Options.Auth}
	switch {
	case strings.Contains(source.NPM, "anthropic"):
		provider.Protocol = "anthropic"
	case source.NPM != "":
		provider.Protocol = "openai"
	}
	if source.Relay != nil {
		provider.Station, provider.Group = source.Relay.Station, source.Relay.Group
		if source.Relay.Auth != "" {
			provider.Auth = source.Relay.Auth
		}
	}
	for id, model := range source.Models {
		if provider.Models == nil {
			provider.Models = map[string]Model{}
		}
		view := Model{Name: model.Name, Window: model.Limit.Context, MaxOutput: model.Limit.Output}
		for level, variant := range model.Variants {
			if !variant.Disabled {
				view.Thinking = append(view.Thinking, level)
			}
		}
		sort.Strings(view.Thinking)
		provider.Models[id] = view
	}
	return provider
}

func keyWarnings(top map[string]json.RawMessage) []string {
	var warnings []string
	keys := make([]string, 0, len(top))
	for key := range top {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		switch {
		case slices.Contains(ignoredKeys, key):
			warnings = append(warnings, key+": this key is not used any more and is ignored")
		case !slices.Contains(v03Keys, key) && !slices.Contains(v1Keys, key):
			warnings = append(warnings, key+": unknown key")
		}
	}
	return warnings
}

// MCPFile returns a configuration file that defines the local MCP servers, in the v0.3 format.
func MCPFile(servers map[string]MCPServer) []byte {
	definitions := make(map[string]fileMCP, len(servers))
	for name, server := range servers {
		command := make([]*string, 0, 1+len(server.Args))
		command = append(command, &server.Command)
		for i := range server.Args {
			command = append(command, &server.Args[i])
		}
		definition := fileMCP{Type: "local", Command: command}
		if len(server.Env) > 0 {
			definition.Environment = make(map[string]*string, len(server.Env))
			for key := range server.Env {
				value := server.Env[key]
				definition.Environment[key] = &value
			}
		}
		definitions[name] = definition
	}
	body, _ := json.Marshal(map[string]any{"mcp": definitions})
	return body
}
