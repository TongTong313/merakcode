package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/clienttool"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/skill"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
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
		var process *mcp.Process
		var err error
		if definition.Remote() {
			process, err = mcp.StartRemote(e.ctx, selected.Name, definition, e.mcpLogin())
		} else {
			process, err = mcp.Start(e.ctx, selected.Name, definition, c.runner.Env)
		}
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
			if e.toolEnabled(operation.Spec().Name) {
				c.runner.Tools.Deferred[operation.Spec().Name] = e.gate.Wrap(operation)
			}
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

// MCPStatus is how a configured MCP server is doing; MCPChange and MCPChanged tell clients to read it again.
type (
	MCPStatus = mcp.Status
	MCPChange = mcp.Change
)

// MCPChanged is the event that follows a login, a logout or a failed login.
const MCPChanged = mcp.Changed

func (e *Engine) mcpLogin() *mcp.Login {
	e.mcpLoginOnce.Do(func() { e.mcpLoginSet = &mcp.Login{Vault: e.vault} })
	return e.mcpLoginSet
}

// MCPStatus connects to every enabled MCP server of the user, and of the project when its directory is given and the
// user trusts the entry, and reports how each one is doing. Entries of a project that were not confirmed are shown
// as disabled until the user decides.
func (e *Engine) MCPStatus(ctx context.Context, directory string) ([]MCPStatus, error) {
	directory = e.directory(directory)
	servers := e.mcpDefinitions(ctx, directory)
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	launcher := &sandbox.Launcher{Disabled: true}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	env := tool.Env{Workdir: directory, Sandbox: launcher}
	statuses := make([]MCPStatus, len(names))
	var wait sync.WaitGroup
	for i, name := range names {
		wait.Add(1)
		go func() {
			defer wait.Done()
			statuses[i] = mcp.Probe(ctx, name, servers[name], e.mcpLogin(), env)
		}()
	}
	wait.Wait()
	return statuses, nil
}

// mcpDefinitions returns the MCP servers that apply to a folder: the user's, and those of the project, which stay
// disabled until the user confirmed them.
func (e *Engine) mcpDefinitions(ctx context.Context, directory string) map[string]config.MCPServer {
	settings := e.networkConfiguration()
	servers := make(map[string]config.MCPServer)
	user := make(map[string]bool)
	for name, definition := range settings.MCPServers() {
		servers[name], user[name] = definition, true
	}
	if found, err := config.ReadWorkspace(directory); err == nil {
		project := directory
		if root, err := git.ProjectRoot(ctx, directory); err == nil {
			project = root
		}
		if resolved, err := resolvedSandboxPath(project); err == nil {
			project = resolved
		}
		for name, definition := range found.MCPServers {
			if user[name] {
				continue
			}
			if settings.WorkspaceDecision(project, "mcpServers/"+name, definition.Hash()) != "allow" {
				definition.Disabled = true
			}
			servers[name] = definition
		}
	}
	return servers
}

// MCPAuthenticate starts the login of a remote server and returns the address to open in a browser. When the
// browser comes back, MCPChanged follows; its Code is empty on success.
func (e *Engine) MCPAuthenticate(ctx context.Context, name string) (string, error) {
	definition, ok := e.networkConfiguration().MCPServers()[name]
	if !ok || !definition.Remote() || definition.Disabled || definition.NoOAuth {
		return "", coded(errorcode.SessionRequestFailed, errors.New("this server does not take a login"))
	}
	var auth *mcp.AuthRequired
	if probe, err := mcp.StartRemote(ctx, name, definition, e.mcpLogin()); err == nil {
		_ = probe.Close()
		return "", coded(errorcode.SessionRequestFailed, errors.New("the server is already logged in"))
	} else if !errors.As(err, &auth) {
		return "", coded(errorcode.McpStartFailed, err)
	}
	address, finished, err := e.mcpLogin().Begin(ctx, name, definition.URL, auth, definition)
	if err != nil {
		return "", coded(errorcode.McpStartFailed, err)
	}
	e.workers.Go(func() {
		change := MCPChange{Server: name}
		select {
		case err := <-finished:
			if err != nil {
				change.Code = "MRK-5010"
			}
		case <-e.ctx.Done():
			return
		}
		body, _ := json.Marshal(change)
		_, _ = e.Bus.Publish(e.ctx, event.Event{Stream: event.Stream("engine:" + e.newID()), Type: MCPChanged, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
	})
	return address, nil
}

// MCPLogout forgets the login of a remote server.
func (e *Engine) MCPLogout(ctx context.Context, name string) error {
	if err := e.mcpLogin().Logout(ctx, name); err != nil {
		return err
	}
	body, _ := json.Marshal(MCPChange{Server: name})
	_, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("engine:" + e.newID()), Type: MCPChanged, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
	return err
}

// skillRoots are the folders besides a project's own where skills live.
type skillRoots struct {
	// global is the root that holds a skills folder, ~/.merakcode.
	global string
	// extra are folders that hold skill folders directly (skills.paths of the configuration).
	extra []string
	// urls are the default sources to install from (skills.urls).
	urls []string
}

// ConfigureSkills tells the engine where the user's skills are: the root with a skills folder, extra folders and
// the default install sources. It takes effect for conversations started afterwards.
func (e *Engine) ConfigureSkills(global string, extra, urls []string) {
	e.skillRoots.Store(&skillRoots{global: global, extra: append([]string(nil), extra...), urls: append([]string(nil), urls...)})
}

func (e *Engine) skills(workdir string) (skill.Set, error) {
	roots := e.skillRoots.Load()
	if roots == nil {
		roots = &skillRoots{}
	}
	return skill.Discover(workdir, roots.global, roots.extra...)
}

// SkillList lists the skills that apply to a folder.
func (e *Engine) SkillList(_ context.Context, directory string) (skill.Set, error) {
	return e.skills(e.directory(directory))
}

// SkillSources returns the default places to install skills from.
func (e *Engine) SkillSources() []string {
	if roots := e.skillRoots.Load(); roots != nil {
		return roots.urls
	}
	return nil
}

func (e *Engine) skillTarget(scope, directory string) (string, error) {
	switch scope {
	case "project", "":
		return filepath.Join(e.directory(directory), ".merakcode", "skills"), nil
	case "global":
		if roots := e.skillRoots.Load(); roots != nil && roots.global != "" {
			return filepath.Join(roots.global, "skills"), nil
		}
	}
	return "", coded(errorcode.SessionRequestFailed, errors.New("unknown skill scope"))
}

// SkillDiscover lists what a source offers: an http(s) address with an index.json, or a git repository.
func (e *Engine) SkillDiscover(ctx context.Context, source, token string) ([]skill.Offer, error) {
	if isGit(source) {
		return skill.DiscoverGit(ctx, source, e.skillCache(), token)
	}
	return skill.DiscoverSource(ctx, source)
}

// SkillInstall installs the chosen skills of a source into the project or the user's folder.
func (e *Engine) SkillInstall(ctx context.Context, source, token string, names []string, scope, directory string) ([]string, error) {
	target, err := e.skillTarget(scope, directory)
	if err != nil {
		return nil, err
	}
	if isGit(source) {
		return skill.InstallGit(ctx, source, e.skillCache(), token, names, target)
	}
	return skill.Install(ctx, source, names, target)
}

// SkillUninstall deletes an installed skill from the project or the user's folder.
func (e *Engine) SkillUninstall(_ context.Context, name, scope, directory string) error {
	target, err := e.skillTarget(scope, directory)
	if err != nil {
		return err
	}
	return skill.Uninstall(target, name)
}

func isGit(source string) bool {
	return strings.HasSuffix(source, ".git") || strings.HasPrefix(source, "git@") || strings.HasPrefix(source, "git://") || strings.HasPrefix(source, "ssh://") || strings.HasPrefix(source, "file://")
}

func (e *Engine) skillCache() string {
	if e.dataDir != "" {
		return filepath.Join(e.dataDir, "..", "cache", "skills")
	}
	return filepath.Join(os.TempDir(), "merak-skills")
}

// RegisterClientTool offers a tool of a connected client to the models of the sessions that start afterwards; owner
// names the connection. handler runs a call on the client's side.
func (e *Engine) RegisterClientTool(owner string, definition clienttool.Definition, handler clienttool.Handler) error {
	return e.clientTools.Register(owner, definition, handler)
}

// UnregisterClientTool removes one tool of owner.
func (e *Engine) UnregisterClientTool(owner, name string) { e.clientTools.Unregister(owner, name) }

// DropClientTools removes every tool of owner; the server calls it when the connection closes.
func (e *Engine) DropClientTools(owner string) { e.clientTools.Drop(owner) }

// ClientTools lists the names of the registered client tools.
func (e *Engine) ClientTools() []string { return e.clientTools.Names() }
