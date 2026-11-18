// Package registry holds the engine's models, agent definitions and tool configuration.
package registry

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
)

// Deps supplies the shared engine dependencies and initial provider configuration.
type Deps struct {
	Core            *core.Core
	Catalog         *catalog.Catalog
	Vault           credential.Vault
	NetworkSettings NetworkSettings
	Providers       map[string]model.Provider
}

// New creates a registry with the host's providers and network settings.
func New(d Deps) *Registry {
	r := &Registry{
		core:            d.Core,
		catalog:         d.Catalog,
		vault:           d.Vault,
		networkSettings: d.NetworkSettings,
		providers:       make(map[string]model.Provider),
	}
	if r.networkSettings == nil {
		r.networkSettings = config.NewMemory()
	}
	for name, p := range d.Providers {
		r.providers[name] = &model.Retrying{Provider: r.blobs(p), Price: func(id string, u model.Usage) model.Usage { return r.catalog.Get(name, id).Price.Apply(u) }}
	}
	return r
}

// AgentConfiguration returns the current agent settings.
func (r *Registry) AgentConfiguration() *AgentSettings { return r.agentSettings.Load() }

// DefaultModel returns the current model used by agents without their own model.
func (r *Registry) DefaultModel() *definition.ModelRef { return r.defaultModel.Load() }

// SkillDirectories returns the configured skill folders and installation sources.
func (r *Registry) SkillDirectories() *SkillRoots { return r.skillRoots.Load() }
