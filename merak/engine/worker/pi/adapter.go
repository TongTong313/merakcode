// Package pi translates Pi's LF-delimited RPC stream into worker events.
package pi

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/internal/stdio"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"io"
	"maps"
)

type Runner struct {
	Sandbox *sandbox.Launcher
	Store   store.Store
	Bus     *event.Bus
	Product profile.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Steer: true} }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	return worker.Launch(ctx, r.Bus, a, func(ctx context.Context, inputs <-chan loop.Input) (task.Report, error) {
		return r.execute(ctx, a, inputs)
	})
}
func (r *Runner) execute(ctx context.Context, a worker.Assignment, inputs <-chan loop.Input) (report task.Report, runErr error) {
	j, err := stdio.NewJournal(ctx, r.Bus, r.Store, a, "pi", r.Product.Model)
	if err != nil {
		return report, err
	}
	defer func() { report, runErr = j.Finish(ctx, runErr) }()
	p := r.Product
	if p.Binary == "" {
		p.Binary = "pi"
	}
	p.Env = maps.Clone(p.Env)
	if p.Env == nil {
		p.Env = make(map[string]string)
	}
	p.Env["PI_SKIP_VERSION_CHECK"], p.Env["PI_TELEMETRY"], p.Env["PI_OFFLINE"] = "1", "0", "1"
	a.SandboxProfile.EnvAllow = append(append([]string(nil), a.SandboxProfile.EnvAllow...), "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_OFFLINE")
	args := append([]string{"--mode", "rpc", "--no-session"}, p.Args...)
	if p.Model != "" {
		args = append(args, "--model", p.Model)
	}
	if a.ReadOnly {
		args = append(args, "--tools", "read,grep,find,ls")
	}
	child, err := stdio.Start(ctx, a, p, args, r.Sandbox)
	if err != nil {
		return report, err
	}
	defer child.Close()
	send := func(in loop.Input, steer bool) error {
		text := stdio.Text(in.Parts)
		if !steer {
			var err error
			text, err = j.ReplayPrompt(text)
			if err != nil {
				return err
			}
		}
		if !steer && r.System != "" {
			text = r.System + "\n\n" + text
		}
		cmd := map[string]any{"type": "prompt", "message": text}
		if steer {
			cmd["streamingBehavior"] = "steer"
		}
		if err := child.Write(cmd); err != nil {
			return err
		}
		return j.Input(ctx, in)
	}
	if err := send(loop.Input{Parts: []model.Part{{Text: a.Packet}}, Cause: a.Cause}, false); err != nil {
		return report, err
	}
	for {
		select {
		case <-ctx.Done():
			return report, ctx.Err()
		case in := <-inputs:
			if err := send(in, true); err != nil {
				return report, err
			}
		case line, ok := <-child.Lines:
			if !ok {
				if err := child.Err(); err != nil {
					return report, err
				}
				return report, io.ErrUnexpectedEOF
			}
			var header struct {
				Type    string
				Success bool
				Aborted bool
				Data    struct{ Disposition string }
			}
			if err := json.Unmarshal(line, &header); err != nil {
				return report, err
			}
			if header.Type == "response" {
				if !header.Success {
					return report, errors.New("pi rejected a command")
				}
				if header.Data.Disposition == "handled" {
					return report, nil
				}
				continue
			}
			if header.Type == "agent_settled" {
				if header.Aborted {
					return report, context.Canceled
				}
				return report, nil
			}
			if err := translate(ctx, j, line); err != nil {
				return report, err
			}
		}
	}
}
