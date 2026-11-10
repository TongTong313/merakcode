package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type MCPServer struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

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
}
type Trust struct {
	Project  string `json:"project"`
	Item     string `json:"item"`
	Hash     string `json:"hash"`
	Decision string `json:"decision"`
}

var serverName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func ReadWorkspace(root string) (Workspace, error) {
	var paths []string
	for _, name := range []string{"merakcode.json", "merakcode.jsonc"} {
		path := filepath.Join(root, name)
		if _, err := os.Stat(path); err == nil {
			paths = append(paths, path)
		} else if !os.IsNotExist(err) {
			return Workspace{}, err
		}
	}
	if len(paths) == 0 {
		return Workspace{}, nil
	}
	if len(paths) != 1 {
		return Workspace{}, errors.New("ambiguous workspace configuration")
	}
	file, err := os.Open(paths[0])
	if err != nil {
		return Workspace{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return Workspace{}, errors.New("workspace configuration could not be read")
	}
	var value Workspace
	if err := decodeConfiguration(data, &value); err != nil {
		return Workspace{}, err
	}
	if err := ValidateMCPServers(value.MCPServers); err != nil {
		return Workspace{}, err
	}
	return value, nil
}

// decodeConfiguration accepts JSON plus comments and trailing commas in either filename.
func decodeConfiguration(data []byte, target any) error {
	clean := bytes.Clone(data)
	quoted, escaped := false, false
	for i := 0; i < len(clean); i++ {
		char := clean[i]
		if quoted {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			continue
		}
		if char != '/' || i+1 == len(clean) {
			continue
		}
		if clean[i+1] == '/' {
			for i < len(clean) && clean[i] != '\n' && clean[i] != '\r' {
				clean[i] = ' '
				i++
			}
			i--
		} else if clean[i+1] == '*' {
			clean[i], clean[i+1] = ' ', ' '
			i += 2
			for i+1 < len(clean) && !(clean[i] == '*' && clean[i+1] == '/') {
				if clean[i] != '\n' && clean[i] != '\r' {
					clean[i] = ' '
				}
				i++
			}
			if i+1 >= len(clean) {
				return errors.New("unterminated configuration comment")
			}
			clean[i], clean[i+1] = ' ', ' '
			i++
		}
	}
	quoted, escaped = false, false
	for i, char := range clean {
		if quoted {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			continue
		}
		if char != ',' {
			continue
		}
		j := i + 1
		for j < len(clean) && strings.ContainsRune(" \t\r\n", rune(clean[j])) {
			j++
		}
		if j < len(clean) && (clean[j] == '}' || clean[j] == ']') {
			k := i - 1
			for k >= 0 && strings.ContainsRune(" \t\r\n", rune(clean[k])) {
				k--
			}
			if k < 0 || strings.ContainsRune("{[,", rune(clean[k])) {
				return errors.New("invalid trailing comma")
			}
			clean[i] = ' '
		}
	}
	clean = bytes.TrimSpace(clean)
	if len(clean) == 0 || clean[0] != '{' {
		return errors.New("configuration must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(clean))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid configuration")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected one configuration object")
	}
	return nil
}

func ValidateMCPServers(servers map[string]MCPServer) error {
	for name, server := range servers {
		if !serverName.MatchString(name) || strings.TrimSpace(server.Command) == "" || strings.ContainsRune(server.Command, '\x00') {
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
	next := clone(s.value)
	for i, old := range next.WorkspaceTrust {
		if old.Project == entry.Project && old.Item == entry.Item && old.Hash == entry.Hash {
			next.WorkspaceTrust[i] = entry
			_, err := s.save(next)
			return err
		}
	}
	next.WorkspaceTrust = append(next.WorkspaceTrust, entry)
	_, err := s.save(next)
	return err
}
