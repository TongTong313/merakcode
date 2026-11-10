package mcp

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

type Process struct {
	Tools  []tool.Tool
	client *Client
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

func Start(ctx context.Context, name string, definition config.MCPServer, env tool.Env) (*Process, error) {
	ctx, cancel := context.WithCancel(ctx)
	startup, stopStartup := context.WithTimeout(ctx, 10*time.Second)
	defer stopStartup()
	stopCancel := context.AfterFunc(startup, cancel)
	defer stopCancel()
	command := definition.Command
	if !filepath.IsAbs(command) && strings.ContainsAny(command, "/\\") {
		command = filepath.Join(env.Workdir, command)
	}
	profile := env.SandboxProfile
	profile.EnvAllow = append([]string(nil), profile.EnvAllow...)
	for key := range definition.Env {
		profile.EnvAllow = append(profile.EnvAllow, key)
	}
	cmd, err := env.Sandbox.Command(ctx, profile, command, definition.Args...)
	if err != nil {
		cancel()
		return nil, err
	}
	cmd.Dir = env.Workdir
	cmd.Env = cmd.Environ()
	for key, value := range definition.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Stderr = io.Discard
	input, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		cancel()
		return nil, err
	}
	hold := env.Sandbox.Hold()
	if err := env.Sandbox.Start(cmd, profile); err != nil {
		hold()
		input.Close()
		output.Close()
		cancel()
		return nil, err
	}
	p := &Process{cancel: cancel, done: make(chan struct{})}
	go func() { defer close(p.done); defer hold(); defer cancel(); _ = env.Sandbox.Wait(cmd) }()
	p.client, err = Connect(startup, name, output, input)
	if err == nil {
		p.Tools, err = p.client.Tools(startup)
	}
	if err != nil {
		p.Close()
		return nil, err
	}
	if !stopCancel() || startup.Err() != nil {
		p.Close()
		return nil, context.DeadlineExceeded
	}
	return p, nil
}

func (p *Process) Close() error {
	p.once.Do(func() {
		p.cancel()
		if p.client != nil {
			_ = p.client.Close()
		}
		<-p.done
	})
	return nil
}
