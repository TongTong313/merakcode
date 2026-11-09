package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

type NetworkSettings interface {
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
