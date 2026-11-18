package registry

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// Registry owns the model providers, agent settings and tool configuration.
type Registry struct {
	core            *core.Core
	catalog         *catalog.Catalog
	vault           credential.Vault
	providers       map[string]model.Provider
	providersMu     sync.RWMutex
	catalogOnce     sync.Once
	defaultModel    atomic.Pointer[definition.ModelRef]
	smallModel      atomic.Pointer[definition.ModelRef]
	agentSettings   atomic.Pointer[AgentSettings]
	toolSwitches    atomic.Pointer[map[string]bool]
	networkSettings NetworkSettings
	networkMu       sync.RWMutex
	mcpLoginSet     *mcp.Login
	mcpLoginOnce    sync.Once
	personal        atomic.Pointer[[]string]
	sandboxMu       sync.Mutex
	mcpProcesses    map[event.ID][]*mcp.Process
	AgentMu         sync.Mutex
	skillRoots      atomic.Pointer[SkillRoots]
}

// MCPServer is the executable configuration exchanged with an engine host.
type MCPServer = config.MCPServer

// WorkspaceTrust identifies a host's decision for one version of a workspace entry.
type WorkspaceTrust = config.Trust

type NetworkSettings interface {
	MCPServers() map[string]MCPServer
	WorkspaceDecision(project, item, hash string) string
	RememberWorkspaceTrust(WorkspaceTrust) error
	permission.Settings
	AllowedNetworkHosts() []string
	DeniedNetworkHosts() []string
	AllowNetworkHost(string) error
	UnconfinedDecision(member, project string) string
	RememberUnconfinedDecision(member, project, decision string) error
}

func (e *Registry) ConfigureNetworkSettings(settings NetworkSettings) {
	if settings == nil {
		return
	}
	e.networkMu.Lock()
	defer e.networkMu.Unlock()
	e.networkSettings = settings
}

func (e *Registry) NetworkConfiguration() NetworkSettings {
	e.networkMu.RLock()
	defer e.networkMu.RUnlock()
	return e.networkSettings
}

func (e *Registry) SetProvider(name string, provider model.Provider) {
	e.providersMu.Lock()
	defer e.providersMu.Unlock()
	if provider == nil {
		delete(e.providers, name)
		return
	}
	e.providers[name] = &model.Retrying{Provider: e.blobs(provider), Price: func(id string, usage model.Usage) model.Usage { return e.catalog.Get(name, id).Price.Apply(usage) }}
}

func (e *Registry) Provider(name string) model.Provider {
	e.providersMu.RLock()
	defer e.providersMu.RUnlock()
	return e.providers[name]
}

func (e *Registry) ConfigureModels(overrides []catalog.Override) { e.catalog.Configure(overrides) }

func (e *Registry) RefreshModels(ctx context.Context, provider string) error {
	return e.catalog.RefreshProvider(ctx, provider)
}

func (e *Registry) Catalog() *catalog.Catalog { return e.catalog }

// ConfigureCatalog sets the providers whose model lists are fetched. The first call reads the cached lists and starts
// the background refresh: stale lists are fetched at once and then every hour, and a provider whose key or address
// changed is fetched right away. MERAKCODE_DISABLE_CATALOG_FETCH=1 keeps the background from sending any request.
func (e *Registry) ConfigureCatalog(sources []catalog.Source) {
	e.catalogOnce.Do(func() {
		hooks := catalog.Hooks{Cache: catalog.StoreCache{Store: e.core.Store}, Now: e.core.Now, Notify: e.notifyCatalog, Disabled: os.Getenv("MERAKCODE_DISABLE_CATALOG_FETCH") == "1"}
		if err := e.catalog.Attach(e.core.Ctx, hooks); err != nil && e.core.Logger != nil {
			e.core.Logger.Warn("model catalog cache could not be read")
		}
		e.core.Workers.Go(func() { e.catalog.Run(e.core.Ctx) })
	})
	e.catalog.ConfigureSources(sources)
}

func (e *Registry) notifyCatalog(provider string, err error) {
	kind, notice := catalog.Refreshed, catalog.Notice{Provider: provider}
	if err != nil {
		kind, notice.Code = catalog.Failed, "MRK-2001"
		var failure *model.Error
		if errors.As(err, &failure) && failure.Code != "" {
			notice.Code = failure.Code
		}
	}
	body, _ := json.Marshal(notice)
	_, _ = e.core.Bus.Publish(e.core.Ctx, event.Event{Stream: event.Stream("engine:" + e.core.NewID()), Type: kind, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}

// ConfigureTools switches tools off or on by name (the v0.3 tools section). A name that ends in * stands for every
// tool whose name starts with the part before it; "exa" stands for both searches. A tool not named stays on. The
// list a session offers is fixed when the session starts.
func (e *Registry) ConfigureTools(switches map[string]bool) {
	copied := make(map[string]bool, len(switches))
	for name, on := range switches {
		copied[name] = on
	}
	e.toolSwitches.Store(&copied)
}

// ToolEnabled says whether the configuration leaves a tool on. An exact name wins over a pattern, and a longer
// pattern wins over a shorter one.
func (e *Registry) ToolEnabled(name string) bool {
	switches := e.toolSwitches.Load()
	if switches == nil {
		return true
	}
	return SwitchedOn(*switches, name)
}

// SwitchedOn applies one set of switches to a tool name; a tool the switches do not name is on.
func SwitchedOn(switches map[string]bool, name string) bool {
	if on, ok := switches[name]; ok {
		return on
	}
	if on, ok := switches["exa"]; ok && (name == "web_search" || name == "code_search") {
		return on
	}
	best, enabled := -1, true
	for pattern, on := range switches {
		if prefix, found := strings.CutSuffix(pattern, "*"); found && strings.HasPrefix(name, prefix) && len(prefix) > best {
			best, enabled = len(prefix), on
		}
	}
	return enabled
}

func (e *Registry) DiscoverModels(ctx context.Context, provider config.Provider) ([]catalog.Model, error) {
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

// Vault returns the shared credential vault used by the engine host.
func (e *Registry) Vault() credential.Vault { return e.vault }
