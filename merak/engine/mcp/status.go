package mcp

import (
	"context"
	"errors"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

// Changed tells clients that a server's login or state changed, so they read the status again.
const Changed event.Type = "mcp.changed"

// Change is the payload of Changed; Code is set when a login failed.
type Change struct {
	Server string `json:"server"`
	Code   string `json:"code,omitempty"`
}

func init() { event.Register[Change](Changed) }

// Status is how one configured server is doing.
type Status struct {
	Name string `json:"name"`
	// Status is connected, needs_auth, failed or disabled.
	Status string `json:"status"`
	Tools  int    `json:"tools"`
	// Code is the MRK code of a failure.
	Code   string `json:"code,omitempty"`
	Remote bool   `json:"remote,omitempty"`
}

const defaultWait = 10 * time.Second

func waitOf(definition config.MCPServer) time.Duration {
	if definition.Timeout > 0 {
		return time.Duration(definition.Timeout) * time.Millisecond
	}
	return defaultWait
}

// StartRemote connects to a remote server and lists its tools. A server that wants a login gives *AuthRequired.
func StartRemote(ctx context.Context, name string, definition config.MCPServer, login *Login) (*Process, error) {
	startup, stop := context.WithTimeout(ctx, waitOf(definition))
	defer stop()
	options := HTTPOptions{URL: definition.URL, Headers: definition.Headers}
	if login != nil && !definition.NoOAuth {
		options.Token = func(ctx context.Context) (string, error) { return login.Token(ctx, name) }
	}
	client, err := ConnectHTTP(startup, name, options)
	if err != nil {
		return nil, err
	}
	tools, err := client.Tools(startup)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	done := make(chan struct{})
	close(done)
	return &Process{Tools: tools, client: client, cancel: func() {}, done: done}, nil
}

// Probe finds out how a configured server is doing by connecting to it and listing its tools.
func Probe(ctx context.Context, name string, definition config.MCPServer, login *Login, env tool.Env) Status {
	status := Status{Name: name, Remote: definition.Remote()}
	if definition.Disabled {
		status.Status = "disabled"
		return status
	}
	var process *Process
	var err error
	if definition.Remote() {
		process, err = StartRemote(ctx, name, definition, login)
	} else {
		process, err = Start(ctx, name, definition, env)
	}
	var auth *AuthRequired
	switch {
	case errors.As(err, &auth):
		status.Status = "needs_auth"
	case err != nil:
		status.Status, status.Code = "failed", "MRK-5010"
	default:
		status.Status, status.Tools = "connected", len(process.Tools)
		_ = process.Close()
	}
	return status
}

// Prompts lists the prompts of the server this process is connected to.
func (p *Process) Prompts(ctx context.Context) ([]Prompt, error) { return p.client.Prompts(ctx) }

// GetPrompt expands one of its prompts.
func (p *Process) GetPrompt(ctx context.Context, name string, arguments map[string]string) (string, error) {
	return p.client.GetPrompt(ctx, name, arguments)
}
