// Package config stores user configuration and keeps credentials out of public views.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Model struct {
	Name      string   `json:"name,omitempty"`
	Window    int      `json:"window,omitempty"`
	MaxOutput int      `json:"maxOutput,omitempty"`
	Thinking  []string `json:"thinking,omitempty"`
}

type Provider struct {
	Picker       *Picker           `json:"picker,omitempty"`
	Station      string            `json:"station,omitempty"`
	Group        string            `json:"group,omitempty"`
	Auth         string            `json:"auth,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	HasHeaders   bool              `json:"hasHeaders,omitempty"`
	ClearHeaders bool              `json:"clearHeaders,omitempty"`
	Name         string            `json:"name,omitempty"`
	Protocol     string            `json:"protocol,omitempty"`
	BaseURL      string            `json:"baseURL,omitempty"`
	APIKey       string            `json:"apiKey,omitempty"`
	HasKey       bool              `json:"hasKey,omitempty"`
	ClearKey     bool              `json:"clearKey,omitempty"`
	Disabled     bool              `json:"disabled,omitempty"`
	Models       map[string]Model  `json:"models,omitempty"`
}

type Picker struct {
	Include []string `json:"include,omitempty"`
	Exclude []string `json:"exclude,omitempty"`
}

type Value struct {
	Unconfined   []LaunchDecision    `json:"unconfined,omitempty"`
	AllowedHosts []string            `json:"allowedHosts,omitempty"`
	DeniedHosts  []string            `json:"deniedHosts,omitempty"`
	Model        string              `json:"model,omitempty"`
	Thinking     string              `json:"thinking,omitempty"`
	Locale       string              `json:"locale,omitempty"`
	Log          string              `json:"log,omitempty"`
	Providers    map[string]Provider `json:"providers"`
}

type Patch struct {
	Unconfined   *[]LaunchDecision    `json:"unconfined,omitempty"`
	AllowedHosts *[]string            `json:"allowedHosts,omitempty"`
	DeniedHosts  *[]string            `json:"deniedHosts,omitempty"`
	Model        *string              `json:"model,omitempty"`
	Thinking     *string              `json:"thinking,omitempty"`
	Locale       *string              `json:"locale,omitempty"`
	Log          *string              `json:"log,omitempty"`
	Providers    map[string]*Provider `json:"providers,omitempty"`
}

type Store struct {
	mu    sync.Mutex
	path  string
	value Value
}

func Open(path string) (*Store, error) {
	s := &Store{path: path, value: Value{Providers: map[string]Provider{}}}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&s.value); err != nil {
		return nil, errors.New("invalid configuration")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("expected one configuration object")
	}
	if err := Validate(s.value); err != nil {
		return nil, err
	}
	if s.value.Providers == nil {
		s.value.Providers = map[string]Provider{}
	}
	return s, nil
}

func (s *Store) Private() Value {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.value)
}

func (s *Store) Get() Value { return public(s.Private()) }

func (s *Store) Update(patch Patch) (Value, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.update(patch)
}

func (s *Store) update(patch Patch) (Value, error) {
	next := clone(s.value)
	if patch.Unconfined != nil {
		next.Unconfined = append([]LaunchDecision(nil), (*patch.Unconfined)...)
	}
	if patch.AllowedHosts != nil {
		next.AllowedHosts = append([]string(nil), (*patch.AllowedHosts)...)
	}
	if patch.DeniedHosts != nil {
		next.DeniedHosts = append([]string(nil), (*patch.DeniedHosts)...)
	}
	for _, field := range []struct {
		update *string
		value  *string
	}{{patch.Model, &next.Model}, {patch.Thinking, &next.Thinking}, {patch.Locale, &next.Locale}, {patch.Log, &next.Log}} {
		if field.update != nil {
			*field.value = *field.update
		}
	}
	for id, update := range patch.Providers {
		if update == nil {
			delete(next.Providers, id)
			continue
		}
		provider := *update
		if provider.Headers == nil && !provider.ClearHeaders {
			provider.Headers = next.Providers[id].Headers
		}
		if provider.ClearHeaders {
			provider.Headers = nil
		}
		provider.HasHeaders, provider.ClearHeaders = false, false
		if provider.APIKey == "" && !provider.ClearKey {
			provider.APIKey = next.Providers[id].APIKey
		}
		if provider.ClearKey {
			provider.APIKey = ""
		}
		provider.HasKey, provider.ClearKey = false, false
		next.Providers[id] = provider
	}
	if err := Validate(next); err != nil {
		return Value{}, err
	}
	if s.path == "" {
		s.value = clone(next)
		return public(next), nil
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return Value{}, err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return Value{}, err
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), ".config-*")
	if err != nil {
		return Value{}, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return Value{}, err
	}
	if err := file.Sync(); err != nil {
		return Value{}, err
	}
	if err := file.Close(); err != nil {
		return Value{}, err
	}
	if err := os.Rename(file.Name(), s.path); err != nil {
		return Value{}, err
	}
	s.value = clone(next)
	return public(next), nil
}

func public(value Value) Value {
	for id, provider := range value.Providers {
		provider.HasHeaders = len(provider.Headers) > 0
		provider.Headers, provider.ClearHeaders = nil, false
		provider.HasKey = provider.APIKey != ""
		provider.APIKey, provider.ClearKey = "", false
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
