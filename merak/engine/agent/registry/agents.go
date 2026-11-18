package registry

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/window"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// BuiltinAgents are the Leader and the Worker. The build entry of the agent section overrides the Worker's model,
// prompt and tools.
func (e *Registry) BuiltinAgents() []definition.Agent {
	merak := definition.DefaultMerakCode()
	merak.ID = "builtin-merakcode"
	if settings := e.agentSettings.Load(); settings != nil {
		if entry, ok := settings.Agents["build"]; ok && !entry.Disabled {
			merak = overlay(merak, entry)
		}
	}
	return []definition.Agent{merak}
}

// DefinitionByID reads an agent and its owner. An empty ID selects the built-in agent.
func (e *Registry) DefinitionByID(ctx context.Context, id event.ID) (definition.Agent, event.ID, error) {
	for _, p := range e.BuiltinAgents() {
		if p.ID == id || id == "" {
			return p, "", nil
		}
	}
	doc, err := e.core.Store.Fetch(ctx, "agent", string(id))
	if err != nil {
		return definition.Agent{}, "", err
	}
	if doc.Meta["deleted"] == "true" {
		return definition.Agent{}, "", store.ErrNotFound
	}
	var p definition.Agent
	err = json.Unmarshal(doc.Body, &p)
	return p, event.ID(doc.Meta["owner"]), err
}

// overlay puts what an entry of the agent section sets over an agent.
func overlay(base definition.Agent, entry config.Agent) definition.Agent {
	if provider, name, found := strings.Cut(entry.Model, "/"); found && provider != "" && name != "" {
		base.Model = definition.ModelRef{Provider: provider, Model: name}
	}
	if entry.Prompt != "" {
		base.System = entry.Prompt
	}
	if entry.Description != "" {
		base.Summary = entry.Description
	}
	if len(entry.Tools) > 0 {
		base.Switches = entry.Tools
	}
	return base
}

// reservedAgents are the names of the agent section that are not agents of their own.
var reservedAgents = []string{"build", "plan", "title", "summary", "compaction", "memory-extractor"}

// configAgents are the agents the agent section defines under its own names, sorted by name. The names of built-in
// agents and internal jobs are not among them.
func (e *Registry) configAgents() []definition.Agent {
	settings := e.agentSettings.Load()
	if settings == nil {
		return nil
	}
	var found []definition.Agent
	for _, name := range slices.Sorted(maps.Keys(settings.Agents)) {
		entry := settings.Agents[name]
		if slices.Contains(reservedAgents, name) || name == "general" || name == "explore" || entry.Disabled {
			continue
		}
		found = append(found, overlay(definition.Agent{ID: event.ID("config:" + name), Name: name, ToolPool: "worker.default", Source: definition.SourceConfig}, entry))
	}
	return found
}

// subagents are the agents a child can be started as without a file: general and explore, which the configuration
// may change.
var subagents = map[string]string{
	"general": "You are a general-purpose research agent. Work through the question step by step, read what you need and return a complete report.",
	"explore": "You are a fast search agent. Find the files, symbols and facts the question asks for and return short findings with file paths.",
}

func (e *Registry) ListAgents(ctx context.Context, human event.ID) ([]definition.Agent, error) {
	return e.ListAgentsFor(ctx, human, "")
}

// ListAgentsFor lists the agents of a person and, when a folder is given, the agents that folder and the user's
// root define in files. Agents from files are read-only.
func (e *Registry) ListAgentsFor(ctx context.Context, human event.ID, directory string) ([]definition.Agent, error) {
	result := e.BuiltinAgents()
	if directory != "" {
		global := ""
		if roots := e.skillRoots.Load(); roots != nil {
			global = roots.Global
		}
		result = append(result, definition.FromFiles(e.directory(directory), global)...)
	}
	result = append(result, e.configAgents()...)
	docs, err := e.core.Store.List(ctx, "agent", "")
	if err != nil {
		return nil, err
	}
	for _, meta := range docs {
		if meta.Meta["owner"] != string(human) || human == "" || meta.Meta["deleted"] == "true" {
			continue
		}
		doc, err := e.core.Store.Fetch(ctx, "agent", meta.Key)
		if err != nil {
			return nil, err
		}
		var p definition.Agent
		if err := json.Unmarshal(doc.Body, &p); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, nil
}

func ValidateAgentNetwork(p definition.Agent) error {
	for _, scope := range p.Memory {
		if scope != "member" && scope != "group" && scope != "project" {
			return errors.New("invalid profile memory scope")
		}
	}
	if err := p.Budget.Validate(); err != nil {
		return err
	}
	if (p.Product == nil || p.Product.Kind == definition.KindBuiltin) && len(p.Network) != 0 {
		return errors.New("network hosts are only available to external member profiles")
	}
	return (sandbox.Network{Mode: "allowlist", Hosts: p.Network}).Validate()
}

func ValidateAgent(p definition.Agent) error {
	if err := ValidateAgentNetwork(p); err != nil {
		return err
	}
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("agent name is required")
	}
	// The tools of a Leader seat come from the seat; the pool of the agent is what it works with as a Worker.
	if p.ToolPool != "" && p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" {
		return errors.New("agent requires worker tools")
	}
	if p.Product == nil {
		return nil
	}
	if p.Product.Kind == definition.KindRemote {
		source := p.Product.Remote
		if source == nil || source.Connection == "" || source.Group == "" || source.Member == "" || p.Product.Binary != "" || len(p.Product.Args) != 0 || len(p.Product.Env) != 0 || len(p.Network) != 0 {
			return errors.New("remote profiles require a connection and a source member")
		}
		return nil
	}
	if p.Product.Remote != nil {
		return errors.New("only remote profiles can select a remote source")
	}
	if strings.TrimSpace(p.Product.Binary) == "" {
		return errors.New("product binary is required")
	}
	switch p.Product.Kind {
	case definition.KindClaudeCode, definition.KindCodex, definition.KindOpenCode, definition.KindPi, definition.KindACP, definition.KindCommand:
		return nil
	default:
		return errors.New("unsupported worker product")
	}
}

func AgentSecretKey(id, name string) string { return "agent:" + id + ":" + name }

// WithAgentSecrets fills the environment values of an external agent that are empty from the vault.
func (e *Registry) WithAgentSecrets(ctx context.Context, p definition.Agent) (definition.Agent, error) {
	if p.Product == nil || len(p.Product.Env) == 0 || p.ID == "" {
		return p, nil
	}
	product := *p.Product
	product.Env = make(map[string]string, len(p.Product.Env))
	for name, value := range p.Product.Env {
		if value == "" {
			stored, err := e.vault.Get(ctx, AgentSecretKey(string(p.ID), name))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return definition.Agent{}, err
			}
			value = string(stored)
		}
		product.Env[name] = value
	}
	p.Product = &product
	return p, nil
}

// AgentNamed finds an agent a child can be started as: a library agent defined in a file under the folder or the
// user's root.
func (e *Registry) AgentNamed(name, directory string) (definition.Agent, bool) {
	if settings := e.agentSettings.Load(); settings != nil && settings.Agents[name].Disabled {
		return definition.Agent{}, false
	}
	for _, found := range e.configAgents() {
		if found.Name == name {
			return found, true
		}
	}
	if prompt, ok := subagents[name]; ok {
		found := definition.Agent{ID: event.ID("builtin:" + name), Name: name, ToolPool: "worker.default", System: prompt, Source: definition.SourceConfig}
		if settings := e.agentSettings.Load(); settings != nil {
			found = overlay(found, settings.Agents[name])
		}
		return found, true
	}
	global := ""
	if roots := e.skillRoots.Load(); roots != nil {
		global = roots.Global
	}
	for _, found := range definition.FromFiles(directory, global) {
		if found.Name == name {
			return found, true
		}
	}
	return definition.Agent{}, false
}

// AgentSettings are the agent section and default_agent of the configuration.
type AgentSettings struct {
	// Agents are keyed by name: build, general, explore, title, summary, compaction and memory-extractor have a meaning
	// of their own; every other name is an agent.
	Agents map[string]config.Agent
	// Default is the name of the agent a new conversation starts with when the client chooses none.
	Default string
}

// ConfigureAgents applies AgentSettings; it takes effect for the conversations and jobs that start afterwards.
func (e *Registry) ConfigureAgents(settings AgentSettings) {
	copied := AgentSettings{Agents: make(map[string]config.Agent, len(settings.Agents)), Default: settings.Default}
	for name, entry := range settings.Agents {
		copied.Agents[name] = entry
	}
	e.agentSettings.Store(&copied)
}

// ConfiguredJobModel returns the model the configuration names for an internal job (title, summary, compaction or
// memory-extractor), if it names one.
func (e *Registry) ConfiguredJobModel(job string) (definition.ModelRef, bool) {
	settings := e.agentSettings.Load()
	if settings == nil {
		return definition.ModelRef{}, false
	}
	provider, name, found := strings.Cut(settings.Agents[job].Model, "/")
	if !found || provider == "" || name == "" {
		return definition.ModelRef{}, false
	}
	return definition.ModelRef{Provider: provider, Model: name}, true
}

// JobModel is the model of an internal job: the one the configuration names, else the small model, else the default.
func (e *Registry) JobModel(job string) (definition.ModelRef, bool) {
	if ref, ok := e.ConfiguredJobModel(job); ok {
		return ref, true
	}
	return e.smallJobModel()
}

// Summarizer writes the summaries that compaction makes: with the model of the compaction entry when the
// configuration names one, else with the provider of the conversation.
func (e *Registry) Summarizer(own model.Provider) window.ModelSummarizer {
	if ref, ok := e.ConfiguredJobModel("compaction"); ok {
		if provider := e.Provider(ref.Provider); provider != nil {
			return window.ModelSummarizer{Provider: provider, Model: ref.Model}
		}
	}
	return window.ModelSummarizer{Provider: own}
}

// LoadAgentByID reads a saved or built-in agent by its id.
func (e *Registry) LoadAgentByID(ctx context.Context, id event.ID) (definition.Agent, error) {
	found, _, err := e.DefinitionByID(ctx, id)
	return found, err
}
