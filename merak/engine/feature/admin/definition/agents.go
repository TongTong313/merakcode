// Package definition manages saved agent definitions and their secrets.
package definition

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	agentdefinition "github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// Deps supplies the shared objects used to manage agent definitions.
type Deps struct {
	Core     *core.Core
	Registry *registry.Registry
	Groups   *group.Manager
	Vault    credential.Vault
}

// Manager manages saved agent definitions using the existing registry and store.
type Manager struct {
	core     *core.Core
	registry *registry.Registry
	groups   *group.Manager
	vault    credential.Vault
}

// New creates the agent definition manager with the engine's shared dependencies.
func New(d Deps) *Manager {
	return &Manager{core: d.Core, registry: d.Registry, groups: d.Groups, vault: d.Vault}
}

func (e *Manager) DeleteAgent(ctx context.Context, human, id event.ID) error {
	if strings.HasPrefix(string(id), "file:") {
		return errorcode.Coded(errorcode.ProfileOwnerOnly, errors.New("an agent from a file is changed in its file"))
	}
	e.registry.AgentMu.Lock()
	defer e.registry.AgentMu.Unlock()
	doc, err := e.core.Store.Fetch(ctx, "agent", string(id))
	if err != nil {
		return err
	}
	if human == "" || doc.Meta["owner"] != string(human) {
		return errorcode.Coded(errorcode.ProfileOwnerOnly, errors.New("only the agent owner can delete it"))
	}
	facts, err := e.core.Store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return err
	}
	for _, fact := range facts {
		state, err := e.groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return err
		}
		for _, member := range state.Members {
			if member.Agent == id {
				return errorcode.Coded(errorcode.ProfileInUse, errors.New("agent is still assigned to a group member"))
			}
		}
	}
	doc.Meta["deleted"] = "true"
	return e.core.Store.Put(ctx, doc)
}

func (e *Manager) SaveAgent(ctx context.Context, human event.ID, p agentdefinition.Agent) (agentdefinition.Agent, error) {
	if p.Source != "" || strings.HasPrefix(string(p.ID), "file:") {
		return agentdefinition.Agent{}, errorcode.Coded(errorcode.ProfileOwnerOnly, errors.New("an agent from a file is changed in its file"))
	}
	e.registry.AgentMu.Lock()
	defer e.registry.AgentMu.Unlock()
	if human == "" {
		return agentdefinition.Agent{}, errors.New("agent owner is required")
	}
	if err := registry.ValidateAgent(p); err != nil {
		return agentdefinition.Agent{}, err
	}
	for _, builtin := range e.registry.BuiltinAgents() {
		if p.ID == builtin.ID {
			return agentdefinition.Agent{}, errors.New("copy a builtin agent before editing")
		}
	}
	if p.ID == "" {
		p.ID = e.core.NewID()
	}
	doc, err := e.core.Store.Fetch(ctx, "agent", string(p.ID))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return agentdefinition.Agent{}, err
	}
	if err == nil && doc.Meta["owner"] != string(human) {
		return agentdefinition.Agent{}, errorcode.Coded(errorcode.ProfileOwnerOnly, errors.New("only the profile owner can edit it"))
	}
	p, err = e.keepAgentSecrets(ctx, p)
	if err != nil {
		return agentdefinition.Agent{}, err
	}
	body, err := json.Marshal(p)
	if err != nil {
		return agentdefinition.Agent{}, err
	}
	err = e.core.Store.Put(ctx, store.Doc{Kind: "agent", Key: string(p.ID), Rev: doc.Rev, Body: body, Meta: map[string]string{"owner": string(human)}})
	return p, err
}

// keepAgentSecrets moves the non-empty environment values of an external agent into the vault and returns the profile
// without them. An empty value keeps the value that is already stored.
func (e *Manager) keepAgentSecrets(ctx context.Context, p agentdefinition.Agent) (agentdefinition.Agent, error) {
	if p.Product == nil || len(p.Product.Env) == 0 {
		return p, nil
	}
	product := *p.Product
	product.Env = make(map[string]string, len(p.Product.Env))
	for name, value := range p.Product.Env {
		product.Env[name] = ""
		if value == "" {
			continue
		}
		if err := e.vault.Set(ctx, registry.AgentSecretKey(string(p.ID), name), []byte(value)); err != nil {
			return agentdefinition.Agent{}, err
		}
	}
	p.Product = &product
	return p, nil
}
