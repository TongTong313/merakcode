// Package config stores user configuration and keeps credentials out of public views.
package config

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func public(value Value) Value {
	for _, server := range value.MCPServers {
		for name := range server.Env {
			server.Env[name] = ""
		}
	}
	for id, provider := range value.Providers {
		provider.HasHeaders = len(provider.Headers) > 0
		provider.Headers = nil
		provider.HasKey = provider.APIKey != ""
		provider.APIKey = ""
		value.Providers[id] = provider
	}
	return value
}

func clone(value Value) Value {
	data, _ := json.Marshal(value)
	var result Value
	_ = json.Unmarshal(data, &result)
	if result.Providers == nil {
		result.Providers = map[string]Provider{}
	}
	return result
}

func Validate(value Value) error {
	if endpoint := value.Cloud.Endpoint; endpoint != "" {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Scheme != "wss" && (parsed.Scheme != "ws" || parsed.Hostname() != "localhost" && !net.ParseIP(parsed.Hostname()).IsLoopback()) {
			return errors.New("invalid cloud endpoint")
		}
	}
	if value.PermissionMode != "" && value.PermissionMode != "ask" && value.PermissionMode != "auto" && value.PermissionMode != "takeover" {
		return errors.New("invalid permission mode")
	}
	if err := ValidateMCPServers(value.MCPServers); err != nil {
		return err
	}
	for _, entry := range value.WorkspaceTrust {
		if !filepath.IsAbs(entry.Project) || !strings.HasPrefix(entry.Item, "mcpServers/") || !serverName.MatchString(strings.TrimPrefix(entry.Item, "mcpServers/")) || entry.Decision != "allow" && entry.Decision != "deny" {
			return errors.New("invalid workspace trust")
		}
		if hash, err := hex.DecodeString(entry.Hash); err != nil || len(hash) != 32 {
			return errors.New("invalid workspace trust hash")
		}
	}
	if err := validatePermissions(value); err != nil {
		return err
	}
	for _, launch := range value.Unconfined {
		if strings.TrimSpace(launch.Member) == "" || !filepath.IsAbs(launch.Project) || strings.ContainsRune(launch.Project, '\x00') || launch.Decision != "allow" && launch.Decision != "deny" {
			return errors.New("invalid unrestricted startup decision")
		}
	}
	var allowedHosts []string
	for _, host := range value.AllowedHosts {
		if host != "*" {
			allowedHosts = append(allowedHosts, host)
		}
	}
	if err := (sandbox.Network{Mode: "allowlist", Hosts: allowedHosts, Deny: value.DeniedHosts}).Validate(); err != nil {
		return err
	}
	if value.Log != "" && value.Log != "debug" && value.Log != "info" && value.Log != "warn" && value.Log != "error" {
		return errors.New("invalid log level")
	}
	if value.Thinking != "" && !thinking(value.Thinking) {
		return errors.New("invalid thinking level")
	}
	for id, provider := range value.Providers {
		if strings.TrimSpace(id) == "" || strings.ContainsAny(id, "/\\\x00") {
			return errors.New("invalid provider id")
		}
		if provider.Protocol != "" && provider.Protocol != "openai" && provider.Protocol != "anthropic" {
			return errors.New("invalid provider protocol")
		}
		if provider.Auth != "" && provider.Auth != "bearer" && provider.Auth != "x-api-key" {
			return errors.New("invalid authentication type")
		}
		for name, value := range provider.Headers {
			if name == "" {
				return errors.New("invalid header name")
			}
			for _, char := range name {
				if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", char)) {
					return errors.New("invalid header name")
				}
			}
			for _, char := range value {
				if char < 32 && char != '\t' || char == 127 {
					return errors.New("invalid header value")
				}
			}
		}
		if provider.BaseURL != "" {
			u, err := url.Parse(provider.BaseURL)
			if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
				return errors.New("invalid provider endpoint")
			}
		}
		for id, model := range provider.Models {
			if strings.TrimSpace(id) == "" || model.Window < 0 || model.MaxOutput < 0 || model.Window > 0 && model.MaxOutput > model.Window {
				return errors.New("invalid model limits")
			}
			for _, level := range model.Thinking {
				if !thinking(level) {
					return errors.New("invalid model thinking level")
				}
			}
		}
	}
	return nil
}

func thinking(value string) bool {
	switch value {
	case "off", "low", "medium", "high", "xhigh", "max":
		return true
	}
	return false
}

// Public removes keys, header values and MCP environment values from a value.
func Public(value Value) Value { return public(clone(value)) }
