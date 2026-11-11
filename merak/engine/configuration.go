package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	"github.com/TongTong313/merakcode/merak/engine/event"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

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

func (e *Engine) ConfigureNetworkSettings(settings NetworkSettings) {
	if settings == nil {
		return
	}
	e.networkMu.Lock()
	defer e.networkMu.Unlock()
	e.networkSettings = settings
}

func (e *Engine) networkConfiguration() NetworkSettings {
	e.networkMu.RLock()
	defer e.networkMu.RUnlock()
	return e.networkSettings
}

func (e *Engine) SetProvider(name string, provider model.Provider) {
	e.providersMu.Lock()
	defer e.providersMu.Unlock()
	if provider == nil {
		delete(e.providers, name)
		return
	}
	e.providers[name] = &model.Retrying{Provider: provider, Price: func(id string, usage model.Usage) model.Usage { return e.catalog.Get(name, id).Price.Apply(usage) }}
}

func (e *Engine) provider(name string) model.Provider {
	e.providersMu.RLock()
	defer e.providersMu.RUnlock()
	return e.providers[name]
}

func (e *Engine) ConfigureModels(overrides []catalog.Override) { e.catalog.Configure(overrides) }

func (e *Engine) RefreshModels(ctx context.Context, provider string) error {
	return e.catalog.RefreshProvider(ctx, provider)
}

func (e *Engine) Catalog() *catalog.Catalog { return e.catalog }

// ConfigureCatalog sets the providers whose model lists are fetched. The first call reads the cached lists and starts
// the background refresh: stale lists are fetched at once and then every hour, and a provider whose key or address
// changed is fetched right away. MERAKCODE_DISABLE_CATALOG_FETCH=1 keeps the background from sending any request.
func (e *Engine) ConfigureCatalog(sources []catalog.Source) {
	e.catalogOnce.Do(func() {
		hooks := catalog.Hooks{Cache: catalog.StoreCache{Store: e.store}, Now: e.now, Notify: e.notifyCatalog, Disabled: os.Getenv("MERAKCODE_DISABLE_CATALOG_FETCH") == "1"}
		if err := e.catalog.Attach(e.ctx, hooks); err != nil && e.logger != nil {
			e.logger.Warn("model catalog cache could not be read")
		}
		e.workers.Go(func() { e.catalog.Run(e.ctx) })
	})
	e.catalog.ConfigureSources(sources)
}

func (e *Engine) notifyCatalog(provider string, err error) {
	kind, notice := catalog.Refreshed, catalog.Notice{Provider: provider}
	if err != nil {
		kind, notice.Code = catalog.Failed, "MRK-2001"
		var failure *model.Error
		if errors.As(err, &failure) && failure.Code != "" {
			notice.Code = failure.Code
		}
	}
	body, _ := json.Marshal(notice)
	_, _ = e.Bus.Publish(e.ctx, event.Event{Stream: event.Stream("engine:" + e.newID()), Type: kind, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}
