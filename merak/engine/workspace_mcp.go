package engine

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func (e *Engine) prepareMCP(ctx context.Context, c *conversation) {
	if c.mcpReady {
		return
	}
	c.mcpReady = true
	if c.state.Config.Parent != "" || c.state.Config.ToolPool == "worker.readonly" {
		return
	}
	settings := e.networkConfiguration()
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
	workspace, err := config.ReadWorkspace(c.state.Config.Workdir)
	if err != nil {
		e.mcpWarning(ctx, c, "MRK-3002", "")
	}
	for name, definition := range workspace.MCPServers {
		if !user[name] {
			configured[name] = definition
		}
	}
	projectPath, err := e.executionProject(ctx, c.state.Scope, c.state.Config.Workdir)
	if err != nil {
		e.mcpWarning(ctx, c, "MRK-3002", "")
		return
	}
	project, err := resolvedSandboxPath(projectPath)
	if err != nil {
		e.mcpWarning(ctx, c, "MRK-3002", "")
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
	if c.state.MCP == nil {
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
		fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + c.state.ID), Scope: c.state.Scope, Type: session.MCPConfigured, Actor: event.Actor{Kind: event.ActorAgent, ID: c.state.Config.Member}, Payload: body})
		if err != nil {
			return
		}
		if err := session.Fold(c.state, fact); err != nil {
			return
		}
	}
	for _, name := range pending {
		e.confirmWorkspaceMCP(c, project, name, configured[name])
	}
	for _, selected := range c.state.MCP.Servers {
		definition, ok := configured[selected.Name]
		if !ok || user[selected.Name] != selected.User || definition.Hash() != selected.Hash {
			continue
		}
		if err := ctx.Err(); err != nil {
			return
		}
		process, err := mcp.Start(e.ctx, selected.Name, definition, c.runner.Env)
		if err != nil {
			e.mcpWarning(ctx, c, "MRK-5010", selected.Name)
			continue
		}
		conflict := false
		for _, operation := range process.Tools {
			name := operation.Spec().Name
			if c.runner.Tools.Tools[name] != nil || c.runner.Tools.Deferred[name] != nil {
				conflict = true
				break
			}
		}
		if conflict {
			_ = process.Close()
			e.mcpWarning(ctx, c, "MRK-5010", selected.Name)
			continue
		}
		e.sandboxMu.Lock()
		if e.mcpProcesses == nil {
			e.mcpProcesses = make(map[event.ID][]*mcp.Process)
		}
		e.mcpProcesses[c.state.ID] = append(e.mcpProcesses[c.state.ID], process)
		e.sandboxMu.Unlock()
		if c.runner.Tools.Deferred == nil {
			c.runner.Tools.Deferred = make(map[string]tool.Tool)
		}
		for _, operation := range process.Tools {
			c.runner.Tools.Deferred[operation.Spec().Name] = e.gate.Wrap(operation)
		}
	}
	c.state.Tools = c.runner.Tools.Specs()
	if deferred := c.runner.Tools.DeferredSpecs(); len(deferred) > 0 {
		body, _ := json.Marshal(deferred)
		c.state.System += "\nAvailable deferred MCP tools (load their schemas before calling):\n" + string(body)
	}
}

func (e *Engine) mcpWarning(ctx context.Context, c *conversation, code, server string) {
	c.state.AddWarning(session.Diagnostic{Code: code, Server: server})
	e.publishMCPWarning(ctx, c.state.Scope, c.state.Config.Member, code, server)
}

func (e *Engine) publishMCPWarning(ctx context.Context, scope event.Scope, member event.ID, code, server string) {
	body, _ := json.Marshal(session.Diagnostic{Code: code, Server: server})
	_, _ = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + scope.Session), Scope: scope, Type: session.Warning, Actor: event.Actor{Kind: event.ActorAgent, ID: member}, Payload: body})
}

func (e *Engine) confirmWorkspaceMCP(c *conversation, project, name string, definition config.MCPServer) {
	entry := config.Trust{Project: project, Item: "mcpServers/" + name, Hash: definition.Hash()}
	var variables []string
	for key := range definition.Env {
		variables = append(variables, key)
	}
	sort.Strings(variables)
	body, _ := json.Marshal(map[string]any{"project": project, "server": name, "command": definition.Command, "args": definition.Args, "env": variables, "hash": entry.Hash})
	scope := c.state.Scope
	scope.Task, scope.Turn = "", ""
	request := permission.Request{Member: c.state.Config.Member, Kind: "workspace", Spec: tool.Spec{Name: "workspace_mcp", Effect: tool.EffectExec, Description: "Confirm this workspace MCP server for future sessions."}, Call: tool.Call{ID: string(e.newID()), Name: "workspace_mcp", Input: body, Env: tool.Env{Workdir: c.state.Config.Workdir, Scope: scope}}}
	e.startWorkspaceConfirmation(entry, request)
}

func (e *Engine) startWorkspaceConfirmation(entry config.Trust, request permission.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return
	}
	e.workspaceMu.Lock()
	if e.workspacePending == nil {
		e.workspacePending = make(map[config.Trust]bool)
	}
	if e.workspacePending[entry] || e.networkConfiguration().WorkspaceDecision(entry.Project, entry.Item, entry.Hash) != "" {
		e.workspaceMu.Unlock()
		return
	}
	e.workspacePending[entry] = true
	e.workspaceMu.Unlock()
	e.workers.Go(func() {
		key := entry
		defer func() { e.workspaceMu.Lock(); delete(e.workspacePending, key); e.workspaceMu.Unlock() }()
		reply, err := e.permissions.Ask(e.ctx, request)
		if err != nil || reply.Decision != permission.Allow && reply.Decision != permission.Deny {
			return
		}
		entry.Decision = string(reply.Decision)
		if err := e.networkConfiguration().RememberWorkspaceTrust(entry); err != nil {
			e.publishMCPWarning(e.ctx, request.Call.Env.Scope, request.Member, "MRK-3001", "")
		}
	})
}

func (e *Engine) recoverWorkspaceConfirmations(ctx context.Context) error {
	facts, err := e.store.Find(ctx, store.Query{Types: []event.Type{permission.Requested, permission.Replied}})
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
		e.startWorkspaceConfirmation(config.Trust{Project: item.Project, Item: "mcpServers/" + item.Server, Hash: item.Hash}, request)
	}
	return nil
}
