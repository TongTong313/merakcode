package engine

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/window"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

// builtinAgents are the Leader and the Worker. The build entry of the agent section overrides the Worker's model,
// prompt and tools.
func (e *Engine) builtinAgents() []agent.Agent {
	leader, worker := agent.DefaultLeader(), agent.DefaultWorker()
	leader.ID, worker.ID = "builtin-leader", "builtin-worker"
	if settings := e.agentSettings.Load(); settings != nil {
		if entry, ok := settings.Agents["build"]; ok && !entry.Disabled {
			worker = overlay(worker, entry)
		}
	}
	return []agent.Agent{leader, worker}
}

// overlay puts what an entry of the agent section sets over an agent.
func overlay(base agent.Agent, entry config.Agent) agent.Agent {
	if provider, name, found := strings.Cut(entry.Model, "/"); found && provider != "" && name != "" {
		base.Model = agent.ModelRef{Provider: provider, Model: name}
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
func (e *Engine) configAgents() []agent.Agent {
	settings := e.agentSettings.Load()
	if settings == nil {
		return nil
	}
	var found []agent.Agent
	for _, name := range slices.Sorted(maps.Keys(settings.Agents)) {
		entry := settings.Agents[name]
		if slices.Contains(reservedAgents, name) || name == "general" || name == "explore" || entry.Disabled {
			continue
		}
		found = append(found, overlay(agent.Agent{ID: event.ID("config:" + name), Name: name, Role: agent.Worker, ToolPool: "worker.default", Source: agent.SourceConfig}, entry))
	}
	return found
}

// subagents are the agents a child can be started as without a file: general and explore, which the configuration
// may change.
var subagents = map[string]string{
	"general": "You are a general-purpose research agent. Work through the question step by step, read what you need and return a complete report.",
	"explore": "You are a fast search agent. Find the files, symbols and facts the question asks for and return short findings with file paths.",
}

func (e *Engine) authorizeMemberAssignment(ctx context.Context, member group.Member, actor event.Actor) error {
	if actor.Kind == event.ActorAgent && actor.ID == member.ID {
		return nil // a member may claim for itself
	}
	p, err := e.memberAgent(ctx, member)
	if err != nil {
		return err
	}
	if !p.Shared && (actor.Kind != event.ActorHuman || actor.ID != member.Owner) {
		return coded(errorcode.ProfileOwnerOnly, errors.New("only the owner can assign an unshared member"))
	}
	return nil
}

func (e *Engine) ListAgents(ctx context.Context, human event.ID) ([]agent.Agent, error) {
	return e.ListAgentsFor(ctx, human, "")
}

// ListAgentsFor lists the agents of a person and, when a folder is given, the agents that folder and the user's
// root define in files. Agents from files are read-only.
func (e *Engine) ListAgentsFor(ctx context.Context, human event.ID, directory string) ([]agent.Agent, error) {
	result := e.builtinAgents()
	if directory != "" {
		global := ""
		if roots := e.skillRoots.Load(); roots != nil {
			global = roots.global
		}
		result = append(result, agent.FromFiles(e.directory(directory), global)...)
	}
	result = append(result, e.configAgents()...)
	docs, err := e.store.List(ctx, "agent", "")
	if err != nil {
		return nil, err
	}
	for _, meta := range docs {
		if meta.Meta["owner"] != string(human) || human == "" || meta.Meta["deleted"] == "true" {
			continue
		}
		doc, err := e.store.Fetch(ctx, "agent", meta.Key)
		if err != nil {
			return nil, err
		}
		var p agent.Agent
		if err := json.Unmarshal(doc.Body, &p); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, nil
}

func (e *Engine) DeleteAgent(ctx context.Context, human, id event.ID) error {
	if strings.HasPrefix(string(id), "file:") {
		return coded(errorcode.ProfileOwnerOnly, errors.New("an agent from a file is changed in its file"))
	}
	e.agentMu.Lock()
	defer e.agentMu.Unlock()
	doc, err := e.store.Fetch(ctx, "agent", string(id))
	if err != nil {
		return err
	}
	if human == "" || doc.Meta["owner"] != string(human) {
		return coded(errorcode.ProfileOwnerOnly, errors.New("only the agent owner can delete it"))
	}
	facts, err := e.store.Find(ctx, store.Query{Types: []event.Type{group.Created}})
	if err != nil {
		return err
	}
	for _, fact := range facts {
		state, err := e.Groups.Get(ctx, fact.Scope.Group)
		if err != nil {
			return err
		}
		for _, member := range state.Members {
			if member.Agent == id {
				return coded(errorcode.ProfileInUse, errors.New("agent is still assigned to a group member"))
			}
		}
	}
	doc.Meta["deleted"] = "true"
	return e.store.Put(ctx, doc)
}

func (e *Engine) SaveAgent(ctx context.Context, human event.ID, p agent.Agent) (agent.Agent, error) {
	if p.Source != "" || strings.HasPrefix(string(p.ID), "file:") {
		return agent.Agent{}, coded(errorcode.ProfileOwnerOnly, errors.New("an agent from a file is changed in its file"))
	}
	e.agentMu.Lock()
	defer e.agentMu.Unlock()
	if human == "" {
		return agent.Agent{}, errors.New("agent owner is required")
	}
	if err := validateAgent(p); err != nil {
		return agent.Agent{}, err
	}
	for _, builtin := range e.builtinAgents() {
		if p.ID == builtin.ID {
			return agent.Agent{}, errors.New("copy a builtin agent before editing")
		}
	}
	if p.ID == "" {
		p.ID = e.newID()
	}
	doc, err := e.store.Fetch(ctx, "agent", string(p.ID))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return agent.Agent{}, err
	}
	if err == nil && doc.Meta["owner"] != string(human) {
		return agent.Agent{}, coded(errorcode.ProfileOwnerOnly, errors.New("only the profile owner can edit it"))
	}
	p, err = e.keepAgentSecrets(ctx, p)
	if err != nil {
		return agent.Agent{}, err
	}
	body, err := json.Marshal(p)
	if err != nil {
		return agent.Agent{}, err
	}
	err = e.store.Put(ctx, store.Doc{Kind: "agent", Key: string(p.ID), Rev: doc.Rev, Body: body, Meta: map[string]string{"owner": string(human)}})
	return p, err
}

func validateAgentNetwork(p agent.Agent) error {
	for _, scope := range p.Memory {
		if scope != "member" && scope != "group" && scope != "project" {
			return errors.New("invalid profile memory scope")
		}
	}
	if err := p.Budget.Validate(); err != nil {
		return err
	}
	if (p.Product == nil || p.Product.Kind == worker.KindBuiltin) && len(p.Network) != 0 {
		return errors.New("network hosts are only available to external member profiles")
	}
	return (sandbox.Network{Mode: "allowlist", Hosts: p.Network}).Validate()
}

func validateAgent(p agent.Agent) error {
	if err := validateAgentNetwork(p); err != nil {
		return err
	}
	if strings.TrimSpace(p.Name) == "" || p.Role != agent.Leader && p.Role != agent.Worker {
		return errors.New("profile name and role are required")
	}
	if p.Role == agent.Leader {
		if p.ToolPool != "leader.default" {
			return errors.New("leader profile requires leader tools")
		}
		if p.Product != nil && p.Product.Kind != worker.KindClaudeCode && p.Product.Kind != worker.KindCodex && p.Product.Kind != worker.KindPi {
			return coded(errorcode.ExternalLeaderUnsupported, errors.New("external leaders require MCP and steering"))
		}
	} else if p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" {
		return errors.New("worker profile requires worker tools")
	}
	if p.Product == nil {
		return nil
	}
	if p.Product.Kind == worker.KindRemote {
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
	case worker.KindClaudeCode, worker.KindCodex, worker.KindOpenCode, worker.KindPi, worker.KindACP, worker.KindCommand:
		return nil
	default:
		return errors.New("unsupported worker product")
	}
}

func agentSecretKey(id, name string) string { return "agent:" + id + ":" + name }

// keepAgentSecrets moves the non-empty environment values of an external agent into the vault and returns the profile
// without them. An empty value keeps the value that is already stored.
func (e *Engine) keepAgentSecrets(ctx context.Context, p agent.Agent) (agent.Agent, error) {
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
		if err := e.vault.Set(ctx, agentSecretKey(string(p.ID), name), []byte(value)); err != nil {
			return agent.Agent{}, err
		}
	}
	p.Product = &product
	return p, nil
}

// withAgentSecrets fills the environment values of an external agent that are empty from the vault.
func (e *Engine) withAgentSecrets(ctx context.Context, p agent.Agent) (agent.Agent, error) {
	if p.Product == nil || len(p.Product.Env) == 0 || p.ID == "" {
		return p, nil
	}
	product := *p.Product
	product.Env = make(map[string]string, len(p.Product.Env))
	for name, value := range p.Product.Env {
		if value == "" {
			stored, err := e.vault.Get(ctx, agentSecretKey(string(p.ID), name))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return agent.Agent{}, err
			}
			value = string(stored)
		}
		product.Env[name] = value
	}
	p.Product = &product
	return p, nil
}

// agentNamed finds an agent a child can be started as: a library agent defined in a file under the folder or the
// user's root.
func (e *Engine) agentNamed(name, directory string) (agent.Agent, bool) {
	if settings := e.agentSettings.Load(); settings != nil && settings.Agents[name].Disabled {
		return agent.Agent{}, false
	}
	for _, found := range e.configAgents() {
		if found.Name == name {
			return found, true
		}
	}
	if prompt, ok := subagents[name]; ok {
		found := agent.Agent{ID: event.ID("builtin:" + name), Name: name, Role: agent.Worker, ToolPool: "worker.default", System: prompt, Source: agent.SourceConfig}
		if settings := e.agentSettings.Load(); settings != nil {
			found = overlay(found, settings.Agents[name])
		}
		return found, true
	}
	global := ""
	if roots := e.skillRoots.Load(); roots != nil {
		global = roots.global
	}
	for _, found := range agent.FromFiles(directory, global) {
		if found.Name == name {
			return found, true
		}
	}
	return agent.Agent{}, false
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
func (e *Engine) ConfigureAgents(settings AgentSettings) {
	copied := AgentSettings{Agents: make(map[string]config.Agent, len(settings.Agents)), Default: settings.Default}
	for name, entry := range settings.Agents {
		copied.Agents[name] = entry
	}
	e.agentSettings.Store(&copied)
}

// configuredJobModel returns the model the configuration names for an internal job (title, summary, compaction or
// memory-extractor), if it names one.
func (e *Engine) configuredJobModel(job string) (agent.ModelRef, bool) {
	settings := e.agentSettings.Load()
	if settings == nil {
		return agent.ModelRef{}, false
	}
	provider, name, found := strings.Cut(settings.Agents[job].Model, "/")
	if !found || provider == "" || name == "" {
		return agent.ModelRef{}, false
	}
	return agent.ModelRef{Provider: provider, Model: name}, true
}

// jobModel is the model of an internal job: the one the configuration names, else the small model, else the default.
func (e *Engine) jobModel(job string) (agent.ModelRef, bool) {
	if ref, ok := e.configuredJobModel(job); ok {
		return ref, true
	}
	return e.smallJobModel()
}

// summarizer writes the summaries that compaction makes: with the model of the compaction entry when the
// configuration names one, else with the provider of the conversation.
func (e *Engine) summarizer(own model.Provider) window.ModelSummarizer {
	if ref, ok := e.configuredJobModel("compaction"); ok {
		if provider := e.provider(ref.Provider); provider != nil {
			return window.ModelSummarizer{Provider: provider, Model: ref.Model}
		}
	}
	return window.ModelSummarizer{Provider: own}
}

// applyDefaultAgent gives a conversation that names no agent the agent the configuration makes the default: the one
// default_agent names, else the build agent. What the client chose in options stays.
func (e *Engine) applyDefaultAgent(options *SessionOptions) {
	settings := e.agentSettings.Load()
	if settings == nil {
		return
	}
	name := settings.Default
	if name == "" {
		name = "build"
	}
	chosen := e.builtinAgents()[1]
	if name != "build" && name != chosen.Name {
		found, ok := e.agentNamed(name, options.Workdir)
		if !ok {
			return
		}
		chosen = found
	}
	useAgent(options, chosen)
}

// useAgent starts a conversation as an agent that is not saved in the library: its model, prompt, mode and tools
// apply where the options say nothing.
func useAgent(options *SessionOptions, chosen agent.Agent) {
	if options.Provider == "" && chosen.Model.Provider != "" {
		options.Provider, options.Model, options.Thinking = chosen.Model.Provider, chosen.Model.Model, chosen.Model.Thinking
	}
	options.System += chosen.System
	if options.Mode == "" {
		options.Mode = chosen.Mode
	}
	if len(chosen.Tools) > 0 && len(options.Tools) == 0 {
		options.Tools = chosen.Tools
	}
	options.Switches = chosen.Switches
}
