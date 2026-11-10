package server

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func discoverModels(ctx context.Context, provider config.Provider) ([]catalog.Model, error) {
	if err := config.Validate(config.Value{Providers: map[string]config.Provider{"draft": provider}}); err != nil {
		return nil, err
	}
	if provider.BaseURL == "" {
		return nil, errors.New("discovery requires a provider endpoint")
	}
	protocol := provider.Protocol
	if protocol == "" {
		protocol = "openai"
	}
	c := catalog.New(catalog.Options{Sources: []catalog.Source{{Provider: "draft", Protocol: protocol, BaseURL: provider.BaseURL, APIKey: provider.APIKey, Auth: provider.Auth, Headers: provider.Headers}}})
	if err := c.Refresh(ctx); err != nil {
		return nil, err
	}
	result := []catalog.Model{}
	for _, model := range c.List() {
		if model.Provider == "draft" {
			result = append(result, model)
		}
	}
	return result, nil
}

func (s *Server) configuration() config.Value {
	if s.settings == nil {
		return config.Value{Providers: map[string]config.Provider{}}
	}
	value := s.settings.Get()
	for _, name := range []string{"openai", "anthropic", "deepseek", "moonshot", "zhipu", "dashscope", "gemini", "openrouter"} {
		provider := value.Providers[name]
		if provider.Name == "" {
			provider.Name = name
		}
		if provider.Protocol == "" {
			provider.Protocol = "openai"
			if name == "anthropic" {
				provider.Protocol = "anthropic"
			}
		}
		if provider.BaseURL == "" {
			provider.BaseURL = os.Getenv(strings.ToUpper(name) + "_BASE_URL")
		}
		provider.HasKey = provider.HasKey || os.Getenv(strings.ToUpper(name)+"_API_KEY") != ""
		value.Providers[name] = provider
	}
	return value
}

func (s *Server) configure(patch config.Patch) (config.Value, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	if s.settings == nil {
		return config.Value{}, os.ErrNotExist
	}
	previous := s.settings.Private()
	if _, err := s.settings.Update(patch); err != nil {
		return config.Value{}, err
	}
	next := s.settings.Private()
	for id := range previous.Providers {
		if _, ok := next.Providers[id]; !ok {
			s.engine.SetProvider(id, nil)
		}
	}
	s.applyConfiguration(next)
	return s.configuration(), nil
}

func (s *Server) applyConfiguration(value config.Value) {
	var overrides []catalog.Override
	var sources []catalog.Source
	for name, provider := range value.Providers {
		key, base := provider.APIKey, provider.BaseURL
		if key == "" {
			key = os.Getenv(strings.ToUpper(name) + "_API_KEY")
		}
		if base == "" {
			base = os.Getenv(strings.ToUpper(name) + "_BASE_URL")
		}
		protocol := provider.Protocol
		if protocol == "" {
			protocol = "openai"
			if name == "anthropic" {
				protocol = "anthropic"
			}
		}
		if base == "" {
			if protocol == "anthropic" {
				builtin, _ := anthropic.Builtin(name)
				base = builtin.BaseURL
			} else {
				builtin, _ := openai.Builtin(name)
				base = builtin.BaseURL
			}
		}
		sources = append(sources, catalog.Source{Provider: name, BaseURL: base, APIKey: key, Protocol: protocol, Auth: provider.Auth, Headers: provider.Headers, Disabled: provider.Disabled})
		if provider.Disabled {
			s.engine.SetProvider(name, nil)
			continue
		}
		if provider.Protocol == "anthropic" || provider.Protocol == "" && name == "anthropic" {
			config, _ := anthropic.Builtin(name)
			config.Name = name
			s.engine.SetProvider(name, anthropic.New(anthropic.Options{BaseURL: base, APIKey: key, Config: config, Catalog: s.engine.Catalog(), Auth: provider.Auth, Headers: provider.Headers}))
		} else {
			config, _ := openai.Builtin(name)
			config.Name = name
			s.engine.SetProvider(name, openai.New(openai.Options{BaseURL: base, APIKey: key, Config: config, Catalog: s.engine.Catalog(), Auth: provider.Auth, Headers: provider.Headers}))
		}
		for id, selected := range provider.Models {
			override := catalog.Override{Provider: name, ID: id}
			if selected.Window > 0 {
				override.Window = &selected.Window
			}
			if selected.MaxOutput > 0 {
				override.MaxOutput = &selected.MaxOutput
			}
			if selected.Thinking != nil {
				levels := make([]model.Thinking, len(selected.Thinking))
				for i, level := range selected.Thinking {
					levels[i] = model.Thinking(level)
				}
				override.Thinking = &levels
			}
			overrides = append(overrides, override)
		}
	}
	s.engine.ConfigureModels(overrides)
	provider, name, _ := strings.Cut(value.Model, "/")
	s.engine.SetDefaultModel(provider, name, model.Thinking(value.Thinking))
	s.engine.Catalog().ConfigureSources(sources)
	if s.Level != nil && value.Log != "" {
		var level slog.Level
		if level.UnmarshalText([]byte(value.Log)) == nil {
			s.Level.Set(level)
		}
	}
}
