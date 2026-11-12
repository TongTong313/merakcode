package server

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/command"
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

var builtinProviders = []string{"openai", "anthropic", "deepseek", "moonshot", "zhipu", "dashscope", "gemini", "openrouter"}

func protocolOf(name string) string {
	if name == "anthropic" {
		return "anthropic"
	}
	return "openai"
}

// environmentSource is the model list source of a built-in provider that is configured only by environment variables.
func environmentSource(name string) catalog.Source {
	source := catalog.Source{Provider: name, Protocol: protocolOf(name), APIKey: os.Getenv(strings.ToUpper(name) + "_API_KEY"), BaseURL: os.Getenv(strings.ToUpper(name) + "_BASE_URL")}
	if source.BaseURL != "" {
		return source
	}
	if name == "anthropic" {
		builtin, _ := anthropic.Builtin(name)
		source.BaseURL = builtin.BaseURL
		return source
	}
	builtin, _ := openai.Builtin(name)
	source.BaseURL = builtin.BaseURL
	return source
}

func (s *Server) configuration() config.Value {
	if s.settings == nil {
		return config.Value{Providers: map[string]config.Provider{}}
	}
	value := s.settings.Get()
	for name, provider := range value.Providers {
		provider.HasKey = s.providerKey(context.Background(), name) != ""
		value.Providers[name] = provider
	}
	for _, name := range builtinProviders {
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
		provider.HasKey = provider.HasKey || s.providerKey(context.Background(), name) != "" || os.Getenv(strings.ToUpper(name)+"_API_KEY") != ""
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
	if err := s.keepProviderKeys(context.Background(), &patch); err != nil {
		return config.Value{}, err
	}
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
		key, base := s.providerKey(context.Background(), name), provider.BaseURL
		if key == "" {
			key = provider.APIKey
		}
		if key == "" {
			key = os.Getenv(strings.ToUpper(name) + "_API_KEY")
		}
		if base == "" {
			base = os.Getenv(strings.ToUpper(name) + "_BASE_URL")
		}
		configured := key != "" || base != ""
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
		if configured {
			sources = append(sources, catalog.Source{Provider: name, BaseURL: base, APIKey: key, Protocol: protocol, Auth: provider.Auth, Headers: provider.Headers, Disabled: provider.Disabled})
		}
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
	for _, name := range builtinProviders {
		if _, listed := value.Providers[name]; listed || os.Getenv(strings.ToUpper(name)+"_API_KEY") == "" && os.Getenv(strings.ToUpper(name)+"_BASE_URL") == "" {
			continue
		}
		sources = append(sources, environmentSource(name))
	}
	s.engine.ConfigureModels(overrides)
	s.engine.ConfigureBoard(value.Board.AutoArchiveDays)
	commands := make(map[string]command.Entry, len(value.Commands))
	for name, entry := range value.Commands {
		commands[name] = command.Entry{Template: entry.Template, Description: entry.Description, Agent: entry.Agent, Model: entry.Model}
	}
	s.engine.ConfigureCommands(commands)
	s.engine.ConfigureTools(value.Tools)
	s.engine.ConfigureAgents(engine.AgentSettings{Agents: value.Agents, Default: value.DefaultAgent})
	s.engine.ConfigureRules(value.Rules.User)
	s.engine.ConfigureSkills(s.configRoot, value.Skills.Paths, value.Skills.URLs)
	s.engine.ConfigureMemory(engine.MemorySettings{AutoExtract: value.Memory.AutoExtract, AutoRecall: value.Memory.AutoRecall, Model: value.Memory.Model})
	s.engine.ConfigureSessions(engine.SessionSettings{Snapshot: value.Snapshot, AutoCompact: value.CompactionAuto, RetentionDays: value.RetentionDays})
	provider, name, _ := strings.Cut(value.Model, "/")
	s.engine.SetDefaultModel(provider, name, model.Thinking(value.Thinking))
	small, smallName, _ := strings.Cut(value.SmallModel, "/")
	s.engine.SetSmallModel(small, smallName)
	s.engine.ConfigureCatalog(sources)
	if s.Level != nil && value.Log != "" {
		var level slog.Level
		if level.UnmarshalText([]byte(value.Log)) == nil {
			s.Level.Set(level)
		}
	}
}
