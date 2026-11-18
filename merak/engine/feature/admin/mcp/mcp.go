// Package mcp manages MCP server status and authentication.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"

	agentmcp "github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

// Deps supplies the shared objects used to manage MCP servers.
type Deps struct {
	Core     *core.Core
	Registry *registry.Registry
}

// Manager manages MCP servers using the existing registry and engine lifecycle.
type Manager struct {
	core     *core.Core
	registry *registry.Registry
}

// New creates the MCP manager with the engine's shared dependencies.
func New(d Deps) *Manager {
	return &Manager{core: d.Core, registry: d.Registry}
}

// MCPStatus connects to every enabled MCP server of the user, and of the project when its directory is given and the
// user trusts the entry, and reports how each one is doing. Entries of a project that were not confirmed are shown
// as disabled until the user decides.
func (e *Manager) MCPStatus(ctx context.Context, directory string) ([]agentmcp.Status, error) {
	directory = e.registry.Directory(directory)
	servers := e.registry.MCPDefinitions(ctx, directory)
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	launcher := &sandbox.Launcher{Disabled: true}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	env := tool.Env{Workdir: directory, Sandbox: launcher}
	statuses := make([]agentmcp.Status, len(names))
	var wait sync.WaitGroup
	for i, name := range names {
		wait.Add(1)
		go func() {
			defer wait.Done()
			statuses[i] = agentmcp.Probe(ctx, name, servers[name], e.registry.MCPLogin(), env)
		}()
	}
	wait.Wait()
	return statuses, nil
}

// MCPAuthenticate starts the login of a remote server and returns the address to open in a browser. When the
// browser comes back, mcp.Changed follows; its Code is empty on success.
func (e *Manager) MCPAuthenticate(ctx context.Context, name string) (string, error) {
	definition, ok := e.registry.NetworkConfiguration().MCPServers()[name]
	if !ok || !definition.Remote() || definition.Disabled || definition.NoOAuth {
		return "", errorcode.Coded(errorcode.SessionRequestFailed, errors.New("this server does not take a login"))
	}
	var auth *agentmcp.AuthRequired
	if probe, err := agentmcp.StartRemote(ctx, name, definition, e.registry.MCPLogin()); err == nil {
		_ = probe.Close()
		return "", errorcode.Coded(errorcode.SessionRequestFailed, errors.New("the server is already logged in"))
	} else if !errors.As(err, &auth) {
		return "", errorcode.Coded(errorcode.McpStartFailed, err)
	}
	address, finished, err := e.registry.MCPLogin().Begin(ctx, name, definition.URL, auth, definition)
	if err != nil {
		return "", errorcode.Coded(errorcode.McpStartFailed, err)
	}
	e.core.Workers.Go(func() {
		change := agentmcp.Change{Server: name}
		select {
		case err := <-finished:
			if err != nil {
				change.Code = "MRK-5010"
			}
		case <-e.core.Ctx.Done():
			return
		}
		body, _ := json.Marshal(change)
		_, _ = e.core.Bus.Publish(e.core.Ctx, event.Event{Stream: event.Stream("engine:" + e.core.NewID()), Type: agentmcp.Changed, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
	})
	return address, nil
}

// MCPLogout forgets the login of a remote server.
func (e *Manager) MCPLogout(ctx context.Context, name string) error {
	if err := e.registry.MCPLogin().Logout(ctx, name); err != nil {
		return err
	}
	body, _ := json.Marshal(agentmcp.Change{Server: name})
	_, err := e.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("engine:" + e.core.NewID()), Type: agentmcp.Changed, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
	return err
}
