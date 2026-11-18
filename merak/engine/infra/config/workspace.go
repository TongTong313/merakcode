package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// MCPServer is one MCP server: a command the engine runs ("local") or an address it connects to ("remote").
type MCPServer struct {
	// Type is "local" or "remote"; empty means local.
	Type    string            `json:"type,omitempty"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// URL and Headers belong to a remote server.
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	// Disabled keeps the entry in the file but does not start or connect it.
	Disabled bool `json:"disabled,omitempty"`
	// Timeout is how long the engine waits for the server, in milliseconds; 0 uses the default.
	Timeout int `json:"timeout,omitempty"`
	// Deferred keeps the tools of the server out of the first prompt until the model loads them.
	Deferred bool `json:"deferred,omitempty"`
	// OAuth holds the client of a remote server that needs a login; NoOAuth says the server never does.
	OAuth   *OAuth `json:"oauth,omitempty"`
	NoOAuth bool   `json:"noOAuth,omitempty"`
}

// OAuth is the client a remote MCP server logs in with. Without a client id the engine registers itself.
type OAuth struct {
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

// Remote says whether the server is reached over HTTP.
func (s MCPServer) Remote() bool { return s.Type == "remote" }

func (s *MCPServer) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return errors.New("MCP server must be an object")
	}
	var value MCPServer
	for name, raw := range fields {
		switch name {
		case "command":
			if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &value.Command) != nil {
				return errors.New("MCP command must be a string")
			}
		case "args":
			var args []json.RawMessage
			if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &args) != nil {
				return errors.New("MCP arguments must be an array")
			}
			for _, arg := range args {
				var text string
				if len(arg) == 0 || arg[0] != '"' || json.Unmarshal(arg, &text) != nil {
					return errors.New("MCP arguments must be strings")
				}
				value.Args = append(value.Args, text)
			}
		case "type", "url":
			var text string
			if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &text) != nil {
				return errors.New("MCP " + name + " must be a string")
			}
			if name == "type" {
				value.Type = text
			} else {
				value.URL = text
			}
		case "headers":
			var headers map[string]json.RawMessage
			if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &headers) != nil {
				return errors.New("MCP headers must be an object")
			}
			value.Headers = make(map[string]string, len(headers))
			for key, item := range headers {
				var text string
				if len(item) == 0 || item[0] != '"' || json.Unmarshal(item, &text) != nil {
					return errors.New("MCP header values must be strings")
				}
				value.Headers[key] = text
			}
		case "disabled", "deferred", "noOAuth":
			var flag bool
			if json.Unmarshal(raw, &flag) != nil {
				return errors.New("MCP " + name + " must be a boolean")
			}
			switch name {
			case "disabled":
				value.Disabled = flag
			case "deferred":
				value.Deferred = flag
			default:
				value.NoOAuth = flag
			}
		case "timeout":
			if json.Unmarshal(raw, &value.Timeout) != nil {
				return errors.New("MCP timeout must be a number")
			}
		case "oauth":
			var oauth OAuth
			decoder := json.NewDecoder(strings.NewReader(string(raw)))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&oauth) != nil {
				return errors.New("invalid MCP oauth")
			}
			value.OAuth = &oauth
		case "env":
			var env map[string]json.RawMessage
			if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &env) != nil {
				return errors.New("MCP environment must be an object")
			}
			value.Env = make(map[string]string, len(env))
			for key, item := range env {
				var text string
				if len(item) == 0 || item[0] != '"' || json.Unmarshal(item, &text) != nil {
					return errors.New("MCP environment values must be strings")
				}
				value.Env[key] = text
			}
		default:
			return errors.New("unknown MCP server field")
		}
	}
	*s = value
	return nil
}

func (s MCPServer) Hash() string {
	body, _ := json.Marshal(s)
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

type Workspace struct {
	MCPServers map[string]MCPServer `json:"mcpServers,omitempty"`
	Warnings   []Warning            `json:"warnings,omitempty"`
}
type Trust struct {
	Project  string `json:"project"`
	Item     string `json:"item"`
	Hash     string `json:"hash"`
	Decision string `json:"decision"`
}

var serverName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
var headerName = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// projectFiles are the places a project keeps configuration; later files override earlier ones.
var projectFiles = []string{"merakcode.jsonc", "merakcode.json", ".merakcode/merakcode.jsonc", ".merakcode/merakcode.json"}

// ReadWorkspace reads a project's configuration files. Unknown keys are only reported in the warnings.
func ReadWorkspace(root string) (Workspace, error) {
	value, err := ReadProject(root)
	if err != nil {
		return Workspace{}, err
	}
	return Workspace{MCPServers: value.MCPServers, Warnings: value.Warnings}, nil
}

// ReadProject reads and merges the configuration files of a project directory.
func ReadProject(root string) (Value, error) {
	var merged Value
	scope, err := filepath.Abs(root)
	if err != nil {
		return Value{}, err
	}
	for _, name := range projectFiles {
		file, err := os.Open(filepath.Join(root, filepath.FromSlash(name)))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return Value{}, err
		}
		data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
		file.Close()
		if err != nil || len(data) > 1<<20 {
			return Value{}, errors.New("workspace configuration could not be read")
		}
		value, err := load(data, true)
		if err != nil {
			return Value{}, err
		}
		value.inFile(file.Name())
		if err := ValidateMCPServers(value.MCPServers); err != nil {
			return Value{}, err
		}
		for i := range value.PermissionRules {
			value.PermissionRules[i].Project = scope
		}
		merged = Merge(merged, value)
	}
	return merged, nil
}

func ValidateMCPServers(servers map[string]MCPServer) error {
	for name, server := range servers {
		if !serverName.MatchString(name) || server.Timeout < 0 {
			return errors.New("invalid MCP server")
		}
		switch server.Type {
		case "", "local":
			if strings.TrimSpace(server.Command) == "" || strings.ContainsRune(server.Command, '\x00') || server.URL != "" || len(server.Headers) > 0 {
				return errors.New("invalid MCP server")
			}
		case "remote":
			address, err := url.Parse(server.URL)
			if err != nil || address.Host == "" || address.User != nil || address.Scheme != "https" && address.Scheme != "http" || server.Command != "" || len(server.Args) > 0 || len(server.Env) > 0 {
				return errors.New("invalid MCP server")
			}
			for key, value := range server.Headers {
				if !headerName.MatchString(key) || strings.ContainsAny(value, "\r\n\x00") {
					return errors.New("invalid MCP header")
				}
			}
		default:
			return errors.New("invalid MCP server")
		}
		for _, arg := range server.Args {
			if strings.ContainsRune(arg, '\x00') {
				return errors.New("invalid MCP argument")
			}
		}
		for name, value := range server.Env {
			if !environmentName.MatchString(name) || strings.ContainsRune(value, '\x00') {
				return errors.New("invalid MCP environment")
			}
		}
	}
	return nil
}

func (s *Store) MCPServers() map[string]MCPServer { return s.Private().MCPServers }
func (s *Store) WorkspaceDecision(project, item, hash string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, entry := range s.value.WorkspaceTrust {
		if entry.Project == project && entry.Item == item && entry.Hash == hash {
			return entry.Decision
		}
	}
	return ""
}
func (s *Store) RememberWorkspaceTrust(entry Trust) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := append([]Trust(nil), s.value.WorkspaceTrust...)
	for i, old := range next {
		if old.Project == entry.Project && old.Item == entry.Item && old.Hash == entry.Hash {
			next[i] = entry
			return s.write(setList("workspaceTrust", next))
		}
	}
	return s.write(setList("workspaceTrust", append(next, entry)))
}
