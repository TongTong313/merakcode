package conversation

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Manager) prepareMCP(ctx context.Context, c *Conversation) {
	state := c.State.Read()
	if c.mcpReady {
		return
	}
	c.mcpReady = true
	if state.Config.Parent != "" || state.Config.ToolPool == "worker.readonly" {
		return
	}
	settings := domain.registry.NetworkConfiguration()
	configured := settings.MCPServers()
	if configured == nil {
		configured = make(map[string]config.MCPServer)
	}
	user := map[string]bool{}
	for name := range configured {
		user[name] = true
	}
	for name, definition := range c.mcpServers {
		if !user[name] {
			configured[name] = definition
			user[name] = true
		}
	}
	workspace, err := config.ReadWorkspace(state.Config.Workdir)
	if err != nil {
		domain.mcpWarning(ctx, c, "MRK-3002", "")
	}
	for name, definition := range workspace.MCPServers {
		if !user[name] {
			configured[name] = definition
		}
	}
	projectPath, err := domain.hooks.Project(ctx, state.Scope, state.Config.Workdir)
	if err != nil {
		domain.mcpWarning(ctx, c, "MRK-3002", "")
		return
	}
	project, err := registry.ResolvedSandboxPath(projectPath)
	if err != nil {
		domain.mcpWarning(ctx, c, "MRK-3002", "")
		return
	}
	if root, err := git.ProjectRoot(ctx, project); err == nil {
		project = root
	}
	var names []string
	for name := range configured {
		names = append(names, name)
	}
	sort.Strings(names)
	var pending []string
	if state.MCP == nil {
		selection := session.MCPSelection{Servers: []session.MCPChoice{}}
		for _, name := range names {
			definition := configured[name]
			decision := settings.WorkspaceDecision(project, "mcpServers/"+name, definition.Hash())
			if user[name] || decision == "allow" {
				selection.Servers = append(selection.Servers, session.MCPChoice{Name: name, Hash: definition.Hash(), User: user[name]})
			} else if decision == "" {
				pending = append(pending, name)
			}
		}
		body, _ := json.Marshal(selection)
		_, err := c.State.Publish(ctx, domain.core.Bus, event.Event{Stream: event.Stream("session:" + state.ID), Scope: state.Scope, Type: session.MCPConfigured, Actor: event.Actor{Kind: event.ActorAgent, ID: state.Config.Member}, Payload: body})
		if err != nil {
			return
		}
	}
	for _, name := range pending {
		domain.confirmWorkspaceMCP(c, project, name, configured[name])
	}
	state = c.State.Read()
	for _, selected := range state.MCP.Servers {
		definition, ok := configured[selected.Name]
		if !ok || user[selected.Name] != selected.User || definition.Hash() != selected.Hash {
			continue
		}
		if err := ctx.Err(); err != nil {
			return
		}
		var process *mcp.Process
		var err error
		if definition.Remote() {
			process, err = mcp.StartRemote(domain.core.Ctx, selected.Name, definition, domain.registry.MCPLogin())
		} else {
			process, err = mcp.Start(domain.core.Ctx, selected.Name, definition, c.Runner.Env)
		}
		if err != nil {
			domain.mcpWarning(ctx, c, "MRK-5010", selected.Name)
			continue
		}
		conflict := false
		for _, operation := range process.Tools {
			name := operation.Spec().Name
			if c.Runner.Tools.Tools[name] != nil || c.Runner.Tools.Deferred[name] != nil {
				conflict = true
				break
			}
		}
		if conflict {
			_ = process.Close()
			domain.mcpWarning(ctx, c, "MRK-5010", selected.Name)
			continue
		}
		domain.registry.RegisterMCPProcess(state.ID, process)
		if c.Runner.Tools.Deferred == nil {
			c.Runner.Tools.Deferred = make(map[string]tool.Tool)
		}
		for _, operation := range process.Tools {
			if domain.registry.ToolEnabled(operation.Spec().Name) {
				c.Runner.Tools.Deferred[operation.Spec().Name] = domain.gate.Wrap(operation)
			}
		}
	}
	var systemSuffix string
	if deferred := c.Runner.Tools.DeferredSpecs(); len(deferred) > 0 {
		body, _ := json.Marshal(deferred)
		systemSuffix = "\nAvailable deferred MCP tools (load their schemas before calling):\n" + string(body)
	}
	c.State.SetTools(c.Runner.Tools.Specs(), systemSuffix)
}

func (domain *Manager) mcpWarning(ctx context.Context, c *Conversation, code, server string) {
	state := c.State.Read()
	c.State.AddWarning(session.Diagnostic{Code: code, Server: server})
	domain.publishMCPWarning(ctx, state.Scope, state.Config.Member, code, server)
}

func (domain *Manager) publishMCPWarning(ctx context.Context, scope event.Scope, member event.ID, code, server string) {
	body, _ := json.Marshal(session.Diagnostic{Code: code, Server: server})
	_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + scope.Session), Scope: scope, Type: session.Warning, Actor: event.Actor{Kind: event.ActorAgent, ID: member}, Payload: body})
}

func (domain *Manager) confirmWorkspaceMCP(c *Conversation, project, name string, definition config.MCPServer) {
	state := c.State.Read()
	entry := config.Trust{Project: project, Item: "mcpServers/" + name, Hash: definition.Hash()}
	var variables []string
	for key := range definition.Env {
		variables = append(variables, key)
	}
	sort.Strings(variables)
	body, _ := json.Marshal(map[string]any{"project": project, "server": name, "command": definition.Command, "args": definition.Args, "env": variables, "hash": entry.Hash})
	scope := state.Scope
	scope.Task, scope.Turn = "", ""
	request := permission.Request{Member: state.Config.Member, Kind: "workspace", Spec: tool.Spec{Name: "workspace_mcp", Effect: tool.EffectExec, Description: "Confirm this workspace MCP server for future sessions."}, Call: tool.Call{ID: string(domain.core.NewID()), Name: "workspace_mcp", Input: body, Env: tool.Env{Workdir: state.Config.Workdir, Scope: scope}}}
	domain.startWorkspaceConfirmation(entry, request)
}

func (domain *Manager) startWorkspaceConfirmation(entry config.Trust, request permission.Request) {
	settings := domain.registry.NetworkConfiguration()
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return
	}
	domain.workspaceMu.Lock()
	if domain.workspacePending == nil {
		domain.workspacePending = make(map[config.Trust]bool)
	}
	if domain.workspacePending[entry] || settings.WorkspaceDecision(entry.Project, entry.Item, entry.Hash) != "" {
		domain.workspaceMu.Unlock()
		return
	}
	domain.workspacePending[entry] = true
	domain.workspaceMu.Unlock()
	domain.core.Workers.Go(func() {
		key := entry
		defer func() {
			domain.workspaceMu.Lock()
			delete(domain.workspacePending, key)
			domain.workspaceMu.Unlock()
		}()
		reply, err := domain.askPermission(domain.core.Ctx, request)
		if err != nil || reply.Decision != permission.Allow && reply.Decision != permission.Deny {
			return
		}
		entry.Decision = string(reply.Decision)
		if err := domain.registry.NetworkConfiguration().RememberWorkspaceTrust(entry); err != nil {
			domain.publishMCPWarning(domain.core.Ctx, request.Call.Env.Scope, request.Member, "MRK-3001", "")
		}
	})
}

func (domain *Manager) RecoverWorkspaceConfirmations(ctx context.Context) error {
	facts, err := domain.core.Store.Find(ctx, store.Query{Types: []event.Type{permission.Requested, permission.Replied}})
	if err != nil {
		return err
	}
	answered := make(map[event.ID]bool)
	for _, fact := range facts {
		if fact.Type == permission.Replied {
			answered[fact.Cause] = true
		}
	}
	for _, fact := range facts {
		if fact.Type != permission.Requested || answered[fact.ID] {
			continue
		}
		request, err := event.Decode[permission.Request](fact)
		if err != nil {
			return err
		}
		if request.Kind != "workspace" || request.Spec.Name != "workspace_mcp" {
			continue
		}
		var item struct{ Project, Server, Hash string }
		if err := json.Unmarshal(request.Call.Input, &item); err != nil {
			return err
		}
		request.ID, request.Call.Env.Scope = fact.ID, fact.Scope
		domain.startWorkspaceConfirmation(config.Trust{Project: item.Project, Item: "mcpServers/" + item.Server, Hash: item.Hash}, request)
	}
	return nil
}
