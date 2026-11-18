package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
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

// ignoredKeys are v0.3 keys that v1 does not use any more. The plugin keys are here because v1.0.0 has no plugin
// module.
var ignoredKeys = []string{"mode", "layout", "enterprise", "tool_discovery", "experimental", "plugin", "plugin_options"}

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
	Command     []*string          `json:"command,omitempty"`
	Environment map[string]*string `json:"environment,omitempty"`
	URL         string             `json:"url,omitempty"`
	Headers     map[string]string  `json:"headers,omitempty"`
	Enabled     *bool              `json:"enabled,omitempty"`
	Timeout     int                `json:"timeout,omitempty"`
	Deferred    bool               `json:"deferred,omitempty"`
	OAuth       json.RawMessage    `json:"oauth,omitempty"`
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
//
// strict is set for the configuration files of a project, which come from outside: an entry that cannot be used makes
// the file fail. The file of the user is lenient: such an entry is skipped with a warning and the rest still loads.
func buildValue(top map[string]json.RawMessage, strict bool) (Value, error) {
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
	var snapshotFlag *bool
	var commands map[string]Command
	var tools map[string]bool
	var skills struct {
		Paths []string `json:"paths"`
		URLs  []string `json:"urls"`
	}
	var memory map[string]json.RawMessage
	var compaction map[string]json.RawMessage
	var storage struct {
		RetentionDays *int `json:"retention_days"`
	}
	var mcp map[string]json.RawMessage
	var agents map[string]json.RawMessage
	var providers map[string]fileProvider
	for _, field := range []struct {
		key    string
		target any
	}{
		{"snapshot", &snapshotFlag}, {"tools", &tools}, {"command", &commands}, {"skills", &skills}, {"memory", &memory}, {"compaction", &compaction}, {"storage", &storage}, {"locale", &localeText}, {"logLevel", &level}, {"model", &value.Model}, {"small_model", &value.SmallModel}, {"default_agent", &value.DefaultAgent}, {"agent", &agents},
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
		value.warn(warnings...)
	}
	value.Server = Server{Port: server.Port, Hostname: server.Hostname}
	value.Snapshot, value.CompactionAuto = snapshotFlag == nil || *snapshotFlag, true
	if raw, ok := compaction["auto"]; ok && json.Unmarshal(raw, &value.CompactionAuto) != nil {
		return Value{}, errors.New("invalid compaction.auto")
	}
	for _, name := range slices.Sorted(maps.Keys(compaction)) {
		if name != "auto" {
			value.warn("compaction." + name + ": this key is not used and is ignored")
		}
	}
	for _, name := range slices.Sorted(maps.Keys(memory)) {
		raw := memory[name]
		switch name {
		case "auto_extract":
			var flag bool
			var mode string
			switch {
			case json.Unmarshal(raw, &flag) == nil:
				value.Memory.AutoExtract = flag
			case json.Unmarshal(raw, &mode) == nil && (mode == "signals" || mode == "always"):
				value.Memory.AutoExtract = true
			default:
				return Value{}, errors.New("invalid memory.auto_extract")
			}
		case "auto_recall":
			if json.Unmarshal(raw, &value.Memory.AutoRecall) != nil {
				return Value{}, errors.New("invalid memory.auto_recall")
			}
		case "model":
			if json.Unmarshal(raw, &value.Memory.Model) != nil {
				return Value{}, errors.New("invalid memory.model")
			}
		default:
			value.warn("memory." + name + ": this key is not used and is ignored")
		}
	}
	var agentWarnings []string
	value.Agents, agentWarnings = parseAgents(agents)
	value.warn(agentWarnings...)
	if err := readTooling(&value, top); err != nil {
		return Value{}, err
	}
	value.Skills = Skills{Paths: skills.Paths, URLs: skills.URLs}
	value.Tools = tools
	for name, entry := range commands {
		if strings.TrimSpace(entry.Template) == "" {
			value.warn("command." + name + ": a command needs a template")
			continue
		}
		if value.Commands == nil {
			value.Commands = map[string]Command{}
		}
		value.Commands[name] = entry
	}
	if storage.RetentionDays != nil {
		value.RetentionDays = *storage.RetentionDays
	}
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
	for _, name := range slices.Sorted(maps.Keys(mcp)) {
		var source fileMCP
		if err := json.Unmarshal(mcp[name], &source); err != nil {
			if strict {
				return Value{}, fmt.Errorf("invalid mcp.%s", name)
			}
			value.warn("mcp." + name + ": this entry is not valid and is skipped")
			continue
		}
		if source.Type != "local" && source.Type != "remote" {
			value.warn("mcp." + name + ": unknown server type, skipped")
			continue
		}
		server, err := mcpServer(name, source)
		if err != nil {
			if strict {
				return Value{}, err
			}
			value.warn("mcp." + name + ": this entry is not valid and is skipped")
			continue
		}
		if value.MCPServers == nil {
			value.MCPServers = map[string]MCPServer{}
		}
		value.MCPServers[name] = server
	}
	value.warn(keyWarnings(top)...)
	var extra map[string]json.RawMessage
	_ = decodeKey(top, "server", &extra)
	for _, name := range []string{"mdns", "mdnsDomain", "cors"} {
		if _, ok := extra[name]; ok {
			value.warn("server." + name + ": this key is not used and is ignored")
		}
	}
	return value, nil
}

// mcpServer converts a local server definition; null entries are rejected.
func mcpServer(name string, source fileMCP) (MCPServer, error) {
	server := MCPServer{Timeout: source.Timeout, Deferred: source.Deferred, Disabled: source.Enabled != nil && !*source.Enabled}
	if len(source.OAuth) > 0 {
		var on bool
		if json.Unmarshal(source.OAuth, &on) == nil && !on {
			server.NoOAuth = true
		} else {
			var oauth OAuth
			decoder := json.NewDecoder(strings.NewReader(string(source.OAuth)))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&oauth) != nil {
				return MCPServer{}, fmt.Errorf("invalid mcp.%s", name)
			}
			server.OAuth = &oauth
		}
	}
	if source.Type == "remote" {
		if source.URL == "" || len(source.Command) > 0 {
			return MCPServer{}, fmt.Errorf("invalid mcp.%s", name)
		}
		server.Type, server.URL, server.Headers = "remote", source.URL, source.Headers
		return server, nil
	}
	if len(source.Command) == 0 {
		return MCPServer{}, fmt.Errorf("invalid mcp.%s", name)
	}
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
		definitions[name] = fileDefinition(server)
	}
	body, _ := json.Marshal(map[string]any{"mcp": definitions})
	return body
}

// fileDefinition writes one server the way a v0.3 file spells it.
func fileDefinition(server MCPServer) fileMCP {
	definition := fileMCP{Type: "local", Timeout: server.Timeout, Deferred: server.Deferred}
	if server.Disabled {
		off := false
		definition.Enabled = &off
	}
	switch {
	case server.NoOAuth:
		definition.OAuth = json.RawMessage("false")
	case server.OAuth != nil:
		definition.OAuth, _ = json.Marshal(server.OAuth)
	}
	if server.Remote() {
		definition.Type, definition.URL, definition.Headers = "remote", server.URL, server.Headers
		return definition
	}
	command := server.Command
	definition.Command = append(make([]*string, 0, 1+len(server.Args)), &command)
	for i := range server.Args {
		definition.Command = append(definition.Command, &server.Args[i])
	}
	if len(server.Env) > 0 {
		definition.Environment = make(map[string]*string, len(server.Env))
		for key := range server.Env {
			value := server.Env[key]
			definition.Environment[key] = &value
		}
	}
	return definition
}
